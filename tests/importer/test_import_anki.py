"""Synthetic packages exercise format/state preservation without private data."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from import_anki import ImportFailure, Timing, import_package
from anki import deck_config_pb2, decks_pb2, import_export_pb2, notetypes_pb2
import zstandard


CREATED = int(datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp())
NOW = int(datetime(2024, 1, 5, 18, tzinfo=timezone.utc).timestamp())
COL_SCHEMA = """
CREATE TABLE col (id integer, crt integer, mod integer, scm integer, ver integer,
 dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
CREATE TABLE notes (id integer, guid text, mid integer, mod integer, usn integer,
 tags text, flds text, sfld text, csum integer, flags integer, data text);
CREATE TABLE cards (id integer, nid integer, did integer, ord integer, mod integer,
 usn integer, type integer, queue integer, due integer, ivl integer, factor integer,
 reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);
CREATE TABLE revlog (id integer, cid integer, usn integer, ease integer, ivl integer,
 lastIvl integer, factor integer, time integer, type integer);
"""


def database(path, modern=False, scheduled=True, fsrs=None):
    path.unlink(missing_ok=True)
    db = sqlite3.connect(path)
    db.executescript(COL_SCHEMA)
    config = {"schedVer": 2, "creationOffset": 0, "rollover": 4}
    if fsrs is not None:
        config["fsrs"] = fsrs
    model = {"id": 7, "name": "Cloze TTS", "type": 1,
             "flds": [{"name": "Text"}, {"name": "Extra"}], "css": ".card { color:red; }",
             "tmpls": [{"name": "Cloze", "qfmt": "{{cloze:Text}}", "afmt": "{{cloze:Text}}{{tts ko_KR:Extra}}"}]}
    deck = {"id": 2, "name": "Parent::Child", "conf": 3}
    cfg = {"id": 3, "new": {"delays": [1, 10], "perDay": 7},
           "lapse": {"delays": [5]}, "rev": {"maxIvl": 999, "perDay": 55},
           "desiredRetention": .85, "fsrsParams5": [float(i) for i in range(19)]}
    db.execute("INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
               (1, CREATED, 0, 0, 18 if modern else 11, 0, 0, 0,
                json.dumps(config), json.dumps({"7": model}), json.dumps({"2": deck}),
                json.dumps({"3": cfg}), "{}"))
    db.execute("INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)",
               (100, "guid-1", 7, 4, 2, " tag-one tag-two ", "{{c1::hello}}\x1fworld", "hello", 0, 1, "opaque"))
    states = [(0, 0, 51), (1, 1, NOW+60), (2, 2, 10), (3, 1, NOW+120),
              (2, -1, 20), (2, -2, 11), (2, -3, 12), (1, 3, 13),
              (1, -1, NOW+180), (2, 4, NOW+240)] if scheduled else [(0, 0, 51)]
    for i, (kind, queue, due) in enumerate(states):
        db.execute("INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (200+i, 100, 2, i, 1, 0, kind, queue, due, 10, 2500,
                    5 if kind else 0, 1, 1001, 0, 0, 3,
                    json.dumps({"s": 12.3, "d": 5.6, "lrt": NOW-1000}) if kind == 2 else ""))
    if scheduled:
        db.execute("INSERT INTO revlog VALUES (?,?,?,?,?,?,?,?,?)", (NOW*1000-2000, 201, 0, 3, -60, -10, 2500, 900, 0))
        db.execute("INSERT INTO revlog VALUES (?,?,?,?,?,?,?,?,?)", (NOW*1000-1000, 201, 0, 0, 10, 9, 0, 0, 4))
    if modern:
        db.executescript("""
        CREATE TABLE config (key text,val blob);
        CREATE TABLE deck_config (id integer,name text,config blob);
        CREATE TABLE decks (id integer,name text,common blob,kind blob);
        CREATE TABLE notetypes (id integer,name text,config blob);
        CREATE TABLE fields (ntid integer,ord integer,name text,config blob);
        CREATE TABLE templates (ntid integer,ord integer,name text,config blob);
        """)
        for k, v in config.items():
            db.execute("INSERT INTO config VALUES (?,?)", (k, json.dumps(v).encode()))
        proto_cfg = deck_config_pb2.DeckConfig.Config(
            learn_steps=[1, 10], relearn_steps=[5], fsrs_params_5=list(range(19)),
            fsrs_params_6=list(range(21)), desired_retention=.85, maximum_review_interval=999,
            new_per_day=7, reviews_per_day=55)
        db.execute("INSERT INTO deck_config VALUES (?,?,?)", (3, "Synthetic", proto_cfg.SerializeToString()))
        kind = decks_pb2.Deck.KindContainer(normal=decks_pb2.Deck.Normal(
            config_id=3, new_limit=9, review_limit_today=decks_pb2.Deck.Normal.DayLimit(limit=77, today=4)))
        db.execute("INSERT INTO decks VALUES (?,?,?,?)", (2, "Parent\x1fChild", b"", kind.SerializeToString()))
        nt_cfg = notetypes_pb2.Notetype.Config(kind=1, css=model["css"])
        db.execute("INSERT INTO notetypes VALUES (?,?,?)", (7, "Cloze TTS", nt_cfg.SerializeToString()))
        # Ordinal order must be retained rather than sorted alphabetically.
        for i, name in enumerate(["Text", "Extra"]):
            db.execute("INSERT INTO fields VALUES (?,?,?,?)", (7, i, name, b""))
        template = notetypes_pb2.Notetype.Template.Config(q_format=model["tmpls"][0]["qfmt"], a_format=model["tmpls"][0]["afmt"])
        db.execute("INSERT INTO templates VALUES (?,?,?,?)", (7, 0, "Cloze", template.SerializeToString()))
        db.execute("UPDATE col SET conf='',models='',decks='',dconf=''")
    db.commit()
    db.close()


def package(folder, modern=False, scheduled=True, filename="fixture.apkg", media_name="sound.mp3", fsrs=None, version=1):
    dbpath = folder / "fixture.sqlite"
    database(dbpath, modern, scheduled, fsrs)
    package_path = folder / filename
    with zipfile.ZipFile(package_path, "w") as archive:
        if modern:
            compress = zstandard.ZstdCompressor(write_content_size=False).compress
            archive.writestr("meta", import_export_pb2.PackageMetadata(version=3).SerializeToString())
            archive.writestr("collection.anki21b", compress(dbpath.read_bytes()))
            archive.writestr("collection.anki2", b"dummy must never be opened")
            entries = import_export_pb2.MediaEntries(entries=[import_export_pb2.MediaEntries.MediaEntry(
                name=media_name, size=5, sha1=hashlib.sha1(b"audio").digest())])
            archive.writestr("media", compress(entries.SerializeToString()))
            archive.writestr("0", compress(b"audio"))
        else:
            archive.writestr("collection.anki21" if version == 2 else "collection.anki2", dbpath.read_bytes())
            if version == 2:
                archive.writestr("collection.anki2", b"old dummy")
            archive.writestr("media", json.dumps({"4": media_name}))
            archive.writestr("4", b"audio")
    return package_path


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_legacy_variants_preserve_all_queues_and_raw_schedule(self):
        for version, extension in [(1, "apkg"), (2, "colpkg")]:
            with self.subTest(version=version):
                source = package(self.folder, filename=f"legacy.{extension}", version=version)
                out = self.folder / f"out{version}"
                data = import_package(source, out, "UTC", True, NOW)
                self.assertEqual(len(data["cards"]), 10)
                self.assertEqual([c["queue"] for c in data["cards"]], [0, 1, 2, 1, -1, -2, -3, 3, -1, 4])
                self.assertIsNone(data["cards"][0]["dueAt"])
                self.assertEqual(data["cards"][1]["dueAt"], (NOW+60)*1000)
                self.assertEqual(data["cards"][8]["dueAt"], (NOW+180)*1000)
                self.assertEqual(data["cards"][9]["dueAt"], (NOW+240)*1000)
                self.assertEqual(data["cards"][2]["dueAt"], (CREATED+10*86400+4*3600)*1000)
                self.assertEqual(data["cards"][1]["lastReview"], NOW*1000-2000)
                self.assertEqual(data["cards"][2]["lastReview"], (NOW-1000)*1000)
                self.assertEqual(data["cards"][2]["stability"], 12.3)
                self.assertEqual(data["cards"][4]["raw"]["queue"], -1)
                self.assertEqual(data["notes"][0]["fields"], ["{{c1::hello}}", "world"])
                self.assertEqual(data["noteTypes"][0]["kind"], "cloze")
                self.assertIn("tts ko_KR", data["noteTypes"][0]["templates"][0]["back"])
                self.assertEqual(data["reviews"][0]["interval"], -60)
                self.assertEqual((out / "media/sound.mp3").read_bytes(), b"audio")
                self.assertEqual(data["source"]["sha256"], hashlib.sha256(source.read_bytes()).hexdigest())

    def test_modern_zstd_protobuf_configs_and_explicit_disabled_fsrs(self):
        source = package(self.folder, modern=True, fsrs=False)
        data = import_package(source, self.folder / "out", "UTC", True, NOW)
        cfg = data["decks"][0]["config"]
        self.assertEqual(cfg["parameters"], list(range(21)))
        self.assertEqual(cfg["learningSteps"], [1, 10])
        self.assertEqual(cfg["relearningSteps"], [5])
        self.assertEqual(cfg["newPerDay"], 9)
        self.assertEqual(cfg["reviewPerDay"], 77)
        self.assertFalse(cfg["fsrsEnabled"])
        self.assertEqual(data["decks"][0]["name"], "Parent::Child")
        self.assertEqual(data["noteTypes"][0]["fields"], ["Text", "Extra"])
        self.assertIn("protobuf", cfg["raw"])
        self.assertEqual(len(data["cards"]), 10)

    def test_missing_schedule_warns_or_fails_without_overwriting_existing_output(self):
        source = package(self.folder, scheduled=False)
        out = self.folder / "out"
        data = import_package(source, out, "UTC", False, NOW)
        self.assertIn("No scheduling history", data["warnings"][0])
        previous = (out / "collection.json").read_bytes()
        with self.assertRaisesRegex(ImportFailure, "No scheduling history"):
            import_package(source, out, "UTC", True, NOW)
        self.assertEqual((out / "collection.json").read_bytes(), previous)

    def test_traversal_media_rejected(self):
        source = package(self.folder, media_name="../escaped.mp3")
        with self.assertRaisesRegex(ImportFailure, "unsafe filename"):
            import_package(source, self.folder / "out", "UTC", False, NOW)
        self.assertFalse((self.folder / "escaped.mp3").exists())

    def test_unsupported_metadata_fails_explicitly(self):
        source = self.folder / "future.apkg"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("meta", import_export_pb2.PackageMetadata(version=99).SerializeToString())
        with self.assertRaisesRegex(ImportFailure, "metadata version: 99"):
            import_package(source, self.folder / "out")

    def test_modern_media_checksum_failure_is_explicit(self):
        source = package(self.folder, modern=True)
        with zipfile.ZipFile(source) as archive:
            contents = {name: archive.read(name) for name in archive.namelist()}
        contents["0"] = zstandard.ZstdCompressor().compress(b"other")
        with zipfile.ZipFile(source, "w") as archive:
            for name, content in contents.items():
                archive.writestr(name, content)
        with self.assertRaisesRegex(ImportFailure, "checksum check"):
            import_package(source, self.folder / "out")

    def test_filtered_home_due_and_v1_due_remain_distinct(self):
        timing = Timing(CREATED, {"schedVer": 2, "rollover": 4, "creationOffset": 0}, "UTC", NOW)
        card = {"type": 2, "queue": 2, "due": -10, "odid": 2, "odue": 12}
        self.assertEqual(timing.card_due_at(card), (CREATED+12*86400+4*3600)*1000)
        card.update(type=3, queue=1, odue=NOW+50)
        self.assertEqual(timing.card_due_at(card), (NOW+50)*1000)
        legacy = Timing(CREATED+4*3600, {"schedVer": 1}, "UTC", NOW)
        self.assertEqual(legacy.today, 4)
        self.assertEqual(legacy.day_due_at(12), (CREATED+4*3600+12*86400)*1000)

    def test_day_boundary_and_creation_offset_preserve_original_day_number(self):
        # Creation date is Jan 1 JST; at Jan 6 03:00 JST, study date is Jan 5.
        timing = Timing(CREATED, {"schedVer": 2, "creationOffset": -540, "rollover": 4}, "Asia/Tokyo", NOW)
        self.assertEqual(timing.today, 4)
        self.assertEqual(timing.day_due_at(4), int(datetime(2024, 1, 4, 19, tzinfo=timezone.utc).timestamp())*1000)
        after_rollover = Timing(CREATED, {"schedVer": 2, "creationOffset": -540, "rollover": 4}, "Asia/Tokyo", NOW+3600)
        self.assertEqual(after_rollover.today, 5)

    def test_day_start_override_does_not_change_raw_source_configuration(self):
        source = package(self.folder)
        data = import_package(source, self.folder / "out", "UTC", True, NOW, day_start=6)
        self.assertEqual(data["collection"]["dayStart"], 6)
        self.assertEqual(data["collection"]["raw"]["config"]["rollover"], 4)
        self.assertEqual(data["cards"][2]["dueAt"], (CREATED+10*86400+6*3600)*1000)


if __name__ == "__main__":
    unittest.main()
