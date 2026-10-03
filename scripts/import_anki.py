#!/usr/bin/env python3
"""Normalize Anki packages without importing into/rescheduling a new collection.

Package and schema protobufs come from the official Anki distribution. SQLite is
opened read-only. Source IDs, queues, due values and card payloads never change.
See https://github.com/ankitects/anki/tree/main/rslib/src/import_export/package
and https://github.com/ankitects/anki/blob/main/rslib/src/scheduler/timing.rs.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import zipfile


class ImportFailure(Exception):
    """An actionable package/format error, safe to print without card contents."""


def dependencies() -> tuple[Any, Any, Any, Any, Any]:
    try:
        import zstandard
        from anki import deck_config_pb2, decks_pb2, import_export_pb2, notetypes_pb2
    except (ImportError, OSError) as exc:
        raise ImportFailure(
            "Importer dependencies unavailable. Use Python 3.10–3.13 and install "
            "requirements.txt into .venv (uv pip install --python .venv/bin/python "
            f"-r requirements.txt). Detail: {type(exc).__name__}"
        ) from exc
    return zstandard, deck_config_pb2, decks_pb2, import_export_pb2, notetypes_pb2


def unzstd(data: bytes) -> bytes:
    zstd, *_ = dependencies()
    try:
        # Exported frames do not necessarily include decompressed content size.
        with zstd.ZstdDecompressor().stream_reader(io.BytesIO(data)) as reader:
            return reader.read()
    except zstd.ZstdError as exc:
        raise ImportFailure("Invalid Zstandard payload in Anki package.") from exc


def json_value(value: Any, context: str) -> Any:
    try:
        return json.loads(value)
    except (ValueError, TypeError) as exc:
        raise ImportFailure(f"Invalid JSON in {context}.") from exc


def protobuf(cls: Any, data: bytes, context: str) -> Any:
    try:
        return cls.FromString(data)
    except Exception as exc:
        raise ImportFailure(f"Invalid protobuf in {context}; unsupported or corrupt package.") from exc


def proto_raw(message: Any, data: bytes) -> dict[str, Any]:
    from google.protobuf.json_format import MessageToDict
    return {"protobuf": base64.b64encode(data).decode("ascii"),
            "decoded": MessageToDict(message, preserving_proto_field_name=True)}


def finite_number(value: Any) -> float | None:
    if isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value):
        return value
    return None


class Timing:
    """Original Anki day numbering; convert day dues under the target timezone."""

    def __init__(self, created: int, config: dict[str, Any], tz_name: str, now: int):
        self.created = created
        self.config = config
        self.tz = ZoneInfo(tz_name)
        self.now = now
        self.rollover = int(config.get("rollover", 4)) % 24
        self.version = int(config.get("schedVer", 1))
        if self.version == 1:
            self.today = max(0, (now - created) // 86400)
            self.day_start = datetime.fromtimestamp(created, self.tz).hour
            self.origin_date = None
        else:
            self.day_start = self.rollover
            offset = config.get("creationOffset")
            if offset is not None:
                creation_tz = timezone(timedelta(minutes=-int(offset)))
                self.origin_date = datetime.fromtimestamp(created, creation_tz).date()
                local_now = datetime.fromtimestamp(now, self.tz)
                study_date = local_now.date() - timedelta(days=local_now.hour < self.rollover)
                self.today = max(0, (study_date - self.origin_date).days)
            else:
                # Anki's legacy-v2 timing uses the current fixed offset, not the
                # historical offset, when reconstructing collection creation.
                current_offset = datetime.fromtimestamp(now, self.tz).utcoffset()
                fixed = timezone(current_offset)
                origin = datetime.fromtimestamp(created, fixed).replace(
                    hour=self.rollover, minute=0, second=0, microsecond=0)
                self.legacy_origin = int(origin.timestamp())
                self.origin_date = None
                self.today = max(0, (now - self.legacy_origin) // 86400)

    def day_due_at(self, due: int) -> int:
        if self.version == 1:
            return (self.created + due * 86400) * 1000
        if self.origin_date is None:
            return (self.legacy_origin + due * 86400) * 1000
        date = self.origin_date + timedelta(days=due)
        return int(datetime(date.year, date.month, date.day,
                            self.rollover, tzinfo=self.tz).timestamp()) * 1000

    def card_due_at(self, row: dict[str, Any]) -> int | None:
        if row["type"] not in (0, 1, 2, 3) or row["queue"] not in (-3, -2, -1, 0, 1, 2, 3, 4):
            return None  # Preserve unknown states without inventing their meaning.
        if row["type"] == 0 or row["queue"] == 0:
            return None  # New-card due is an ordering position.
        due, queue = row["due"], row["queue"]
        if row["odid"] and row["odue"]:
            due = row["odue"]
            # Filtered decks may use a temporary queue/position. Home schedule
            # is day-based for reviews and epoch-based for intraday learning.
            queue = 1 if row["type"] in (1, 3) and due > 1_000_000_000 else 2
        if queue in (1, 4) or (queue < 0 and row["type"] in (1, 3) and due > 1_000_000_000):
            return due * 1000
        return self.day_due_at(due)


def package_payload(archive: zipfile.ZipFile) -> tuple[bytes, bool]:
    _, _, _, package_pb, _ = dependencies()
    names = set(archive.namelist())
    if len(names) != len(archive.namelist()):
        raise ImportFailure("Package has duplicate ZIP entries.")
    if "meta" in names:
        meta = protobuf(package_pb.PackageMetadata, archive.read("meta"), "package metadata")
        version = meta.version
        if version not in (1, 2, 3):
            raise ImportFailure(f"Unsupported Anki package metadata version: {version}.")
    else:
        version = 2 if "collection.anki21" in names else 1
    filename = {1: "collection.anki2", 2: "collection.anki21", 3: "collection.anki21b"}[version]
    if filename not in names:
        raise ImportFailure(f"Package is missing {filename}.")
    payload = archive.read(filename)
    payload = unzstd(payload) if version == 3 else payload
    if not payload.startswith(b"SQLite format 3\x00"):
        raise ImportFailure("Collection payload is not a SQLite database.")
    return payload, version == 3


def extract_media(archive: zipfile.ZipFile, modern: bool, target: Path,
                  warnings: list[str]) -> list[dict[str, str]]:
    _, _, _, package_pb, _ = dependencies()
    if "media" not in archive.namelist():
        warnings.append("Package has no media map; no media files were imported.")
        return []
    raw = archive.read("media")
    if modern:
        decoded = protobuf(package_pb.MediaEntries, unzstd(raw), "media map")
        entries = [(str(i), e.name, e.size, e.sha1) for i, e in enumerate(decoded.entries)]
    else:
        mapping = json_value(raw, "media map")
        if not isinstance(mapping, dict):
            raise ImportFailure("Legacy media map must be a JSON object.")
        entries = [(str(k), v, None, None) for k, v in mapping.items()]
    output, seen = [], set()
    target.mkdir()
    for index, name, expected_size, expected_sha in entries:
        if (not isinstance(name, str) or not name or name in (".", "..")
                or any(x in name for x in ("/", "\\", "\x00", ":"))):
            raise ImportFailure("Media map contains an unsafe filename.")
        if not index.isdecimal() or name.casefold() in seen:
            raise ImportFailure("Media map contains an invalid index or duplicate filename.")
        seen.add(name.casefold())
        try:
            content = archive.read(index)
        except KeyError as exc:
            raise ImportFailure(f"Media file {index} is missing from the package.") from exc
        content = unzstd(content) if modern else content
        if modern and (len(content) != expected_size or hashlib.sha1(content).digest() != expected_sha):
            raise ImportFailure(f"Media file {index} failed its size/checksum check.")
        (target / name).write_bytes(content)
        output.append({"name": name, "path": f"media/{name}"})
    return output


def read_metadata(db: sqlite3.Connection, col: dict[str, Any]) -> tuple[dict, list, list, dict]:
    _, deck_config_pb, decks_pb, _, notetype_pb = dependencies()
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if col["ver"] not in (11, 12, 13, 14, 15, 16, 17, 18):
        raise ImportFailure(f"Unsupported Anki SQLite schema version {col['ver']}.")
    if "notetypes" not in tables:
        config = json_value(col["conf"], "collection configuration")
        return (config, list(json_value(col["models"], "note types").values()),
                list(json_value(col["decks"], "decks").values()),
                json_value(col["dconf"], "deck configuration"))
    config = {r["key"]: json_value(r["val"], "collection configuration")
              for r in db.execute("SELECT key,val FROM config")}
    configs = {}
    for row in db.execute("SELECT * FROM deck_config ORDER BY id"):
        pb = protobuf(deck_config_pb.DeckConfig.Config, row["config"], "deck configuration")
        configs[str(row["id"])] = {"id": row["id"], "proto": pb,
                                     "raw": proto_raw(pb, row["config"])}
    decks = []
    for row in db.execute("SELECT * FROM decks ORDER BY id"):
        kind = protobuf(decks_pb.Deck.KindContainer, row["kind"], "deck kind")
        common = protobuf(decks_pb.Deck.Common, row["common"], "deck common")
        normal = kind.normal
        decks.append({"id": row["id"], "name": row["name"].replace("\x1f", "::"),
                      "conf": normal.config_id if kind.WhichOneof("kind") == "normal" else 1,
                      "dyn": kind.WhichOneof("kind") == "filtered", "normal": normal,
                      "raw": {"kind": proto_raw(kind, row["kind"]),
                              "common": proto_raw(common, row["common"])}})
    models = []
    for row in db.execute("SELECT * FROM notetypes ORDER BY id"):
        model = protobuf(notetype_pb.Notetype.Config, row["config"], "note type")
        fields = [{"name": f["name"]} for f in db.execute(
            "SELECT name FROM fields WHERE ntid=? ORDER BY ord", (row["id"],))]
        templates = []
        for template in db.execute("SELECT name,config FROM templates WHERE ntid=? ORDER BY ord", (row["id"],)):
            cfg = protobuf(notetype_pb.Notetype.Template.Config, template["config"], "template")
            templates.append({"name": template["name"], "qfmt": cfg.q_format, "afmt": cfg.a_format})
        models.append({"id": row["id"], "name": row["name"], "type": model.kind,
                       "css": model.css, "flds": fields, "tmpls": templates,
                       "raw": proto_raw(model, row["config"])})
    return config, models, decks, configs


def normalized_config(cfg: dict, deck: dict, fsrs: bool, today: int) -> dict:
    if "proto" in cfg:
        p = cfg["proto"]
        parameters = list(p.fsrs_params_6 or p.fsrs_params_5 or p.fsrs_params_4)
        value = {"desiredRetention": p.desired_retention or 0.9, "parameters": parameters,
                 "learningSteps": list(p.learn_steps), "relearningSteps": list(p.relearn_steps),
                 "maximumInterval": p.maximum_review_interval or 36500,
                 "newPerDay": p.new_per_day, "reviewPerDay": p.reviews_per_day,
                 "fsrsEnabled": fsrs, "raw": cfg["raw"]}
        n = deck.get("normal")
        if n is not None:
            if n.HasField("desired_retention"):
                value["desiredRetention"] = n.desired_retention
            for source, dest in (("new_limit", "newPerDay"), ("review_limit", "reviewPerDay")):
                if n.HasField(source):
                    value[dest] = getattr(n, source)
            for source, dest in (("new_limit_today", "newPerDay"), ("review_limit_today", "reviewPerDay")):
                if n.HasField(source) and getattr(n, source).today == today:
                    value[dest] = getattr(n, source).limit
        return value
    rev, new, lapse = cfg.get("rev", {}), cfg.get("new", {}), cfg.get("lapse", {})
    parameters = cfg.get("fsrsParams6") or cfg.get("fsrsParams5") or cfg.get("fsrsParams4") or cfg.get("fsrsWeights") or []
    return {"desiredRetention": deck.get("desiredRetention", cfg.get("desiredRetention", 0.9)),
            "parameters": parameters, "learningSteps": new.get("delays", [1, 10]),
            "relearningSteps": lapse.get("delays", [10]),
            "maximumInterval": rev.get("maxIvl", 36500), "newPerDay": new.get("perDay", 20),
            "reviewPerDay": rev.get("perDay", 200), "fsrsEnabled": fsrs, "raw": cfg}


def normalize(db: sqlite3.Connection, tz_name: str, now: int, require_scheduling: bool,
              day_start: int | None = None) -> dict:
    db.row_factory = sqlite3.Row
    col = db.execute("SELECT * FROM col LIMIT 1").fetchone()
    if col is None:
        raise ImportFailure("Package collection is empty or corrupt.")
    config, models, decks, configs = read_metadata(db, dict(col))
    source_config = dict(config)
    if day_start is not None:
        config["rollover"] = day_start
    timing = Timing(col["crt"], config, tz_name, now)
    warnings = []
    rows = [dict(row) for row in db.execute("SELECT * FROM cards ORDER BY id")]
    reviews = [dict(row) for row in db.execute("SELECT * FROM revlog ORDER BY id")]
    notes = [dict(row) for row in db.execute("SELECT * FROM notes ORDER BY id")]
    if not rows:
        raise ImportFailure("Package contains no cards.")
    unknown_states = sum(r["type"] not in (0, 1, 2, 3) or r["queue"] not in (-3, -2, -1, 0, 1, 2, 3, 4) for r in rows)
    if unknown_states:
        warnings.append(f"{unknown_states} cards have unknown Anki states. Their raw records were preserved; dueAt is unset.")
    has_schedule = any(r["type"] != 0 or r["queue"] != 0 or r["reps"] for r in rows) or bool(reviews)
    if not has_schedule:
        message = "No scheduling history was present; all imported cards are new. Re-export with scheduling enabled if progress was expected."
        if require_scheduling:
            raise ImportFailure(message)
        warnings.append(message)
    memory = []
    for row in rows:
        try:
            data = json.loads(row["data"] or "{}")
            memory.append(data if isinstance(data, dict) else {})
        except ValueError:
            memory.append({})
    if "fsrs" in config:
        fsrs = bool(config["fsrs"])
    else:
        fsrs = any(finite_number(d.get("s")) is not None and finite_number(d.get("d")) is not None for d in memory)
        if fsrs:
            warnings.append("Package omits the global FSRS switch; FSRS enabled was inferred from preserved card memory states. Preset parameters remain unchanged.")
    if day_start is not None:
        warnings.append(f"Source day boundary was explicitly overridden to {day_start:02}:00.")
    elif timing.version == 2 and "rollover" not in config:
        warnings.append("Package omits rollover; Anki's default 04:00 day boundary is used. Re-import with --day-start if the source used another hour.")
    if timing.version == 2 and "creationOffset" not in config:
        warnings.append("No creationOffset is present; Anki's legacy-v2 day numbering is used.")
    normalized_decks = []
    for deck in decks:
        cfgid = str(deck.get("conf", 1))
        cfg = configs.get(cfgid)
        if cfg is None:
            raise ImportFailure(f"Deck {deck['id']} references missing configuration {cfgid}.")
        normalized_decks.append({"id": str(deck["id"]), "name": deck["name"],
                                 "configId": cfgid,
                                 "config": normalized_config(cfg, deck, fsrs, timing.today),
                                 "raw": deck.get("raw", {k: v for k, v in deck.items() if k != "normal"})})
        if deck.get("dyn"):
            warnings.append(f"Filtered deck {deck['id']} is preserved; card originalDue/originalDeckId retain the home-deck schedule.")
    cards = []
    last_reviews = {}
    for review in reviews:
        # Manual/reschedule log records (rating 0, type 4/5) are not actual recalls.
        if 1 <= review["ease"] <= 4 and review["type"] in (0, 1, 2, 3):
            last_reviews[review["cid"]] = max(last_reviews.get(review["cid"], 0), review["id"])
    for row, data in zip(rows, memory):
        lrt = finite_number(data.get("lrt"))
        raw = dict(row)
        for field in ("id", "nid", "did", "odid"):
            raw[field] = str(raw[field])
        cards.append({"id": str(row["id"]), "noteId": str(row["nid"]), "deckId": str(row["did"]),
                      "ordinal": row["ord"], "type": row["type"], "queue": row["queue"],
                      "due": row["due"], "interval": row["ivl"], "easeFactor": row["factor"],
                      "reps": row["reps"], "lapses": row["lapses"], "left": row["left"],
                      "originalDue": row["odue"], "originalDeckId": str(row["odid"]),
                      "flags": row["flags"], "data": row["data"],
                      "stability": finite_number(data.get("s")), "difficulty": finite_number(data.get("d")),
                      "lastReview": int(lrt * 1000) if lrt is not None else last_reviews.get(row["id"]),
                      "dueAt": timing.card_due_at(row), "raw": raw})
    note_types = [{"id": str(m["id"]), "name": m["name"],
                   "kind": "cloze" if m.get("type") == 1 else "normal",
                   "fields": [f["name"] for f in m["flds"]],
                   "templates": [{"name": t["name"], "front": t["qfmt"], "back": t["afmt"]} for t in m["tmpls"]],
                   "css": m.get("css", ""), "raw": m.get("raw", m)} for m in models]
    note_ids, deck_ids, type_ids = {str(n["id"]) for n in notes}, {d["id"] for d in normalized_decks}, {m["id"] for m in note_types}
    if any(c["noteId"] not in note_ids or c["deckId"] not in deck_ids for c in cards):
        raise ImportFailure("A card references a missing note or deck.")
    if any(str(n["mid"]) not in type_ids for n in notes):
        raise ImportFailure("A note references a missing note type.")
    return {"collection": {"createdAt": col["crt"], "timeZone": tz_name, "dayStart": timing.day_start,
                            "today": timing.today, "raw": {"schemaVersion": col["ver"], "config": source_config}},
            "decks": normalized_decks, "noteTypes": note_types,
            "notes": [{"id": str(n["id"]), "guid": n["guid"], "noteTypeId": str(n["mid"]),
                       "fields": n["flds"].split("\x1f"), "tags": n["tags"].split(),
                       "raw": {"mod": n["mod"], "usn": n["usn"], "flags": n["flags"], "data": n["data"]}} for n in notes],
            "cards": cards,
            "reviews": [{"id": str(r["id"]), "cardId": str(r["cid"]), "rating": r["ease"],
                         "reviewedAt": r["id"], "interval": r["ivl"], "lastInterval": r["lastIvl"],
                         "easeFactor": r["factor"], "duration": r["time"], "type": r["type"],
                         "raw": {"usn": r["usn"]}} for r in reviews], "warnings": warnings}


def import_package(source: Path, output: Path, tz_name: str = "Asia/Tokyo",
                   require_scheduling: bool = False, now: int | None = None,
                   day_start: int | None = None) -> dict:
    if source.suffix.lower() not in (".apkg", ".colpkg"):
        raise ImportFailure("Expected an .apkg or .colpkg package.")
    now = int(datetime.now(timezone.utc).timestamp()) if now is None else now
    output = output.absolute()
    if output.is_symlink() or (output / "media").is_symlink():
        raise ImportFailure("Output directory/media must not be symbolic links.")
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".anki-import-", dir=output.parent) as temporary:
        temp = Path(temporary)
        try:
            with zipfile.ZipFile(source) as archive:
                payload, modern = package_payload(archive)
                database = temp / "collection.anki2"
                database.write_bytes(payload)
                db = sqlite3.connect(f"{database.as_uri()}?mode=ro&immutable=1", uri=True)
                try:
                    result = normalize(db, tz_name, now, require_scheduling, day_start)
                finally:
                    db.close()
                result["media"] = extract_media(archive, modern, temp / "media", result["warnings"])
        except zipfile.BadZipFile as exc:
            raise ImportFailure("Package is not a valid ZIP archive.") from exc
        except sqlite3.DatabaseError as exc:
            raise ImportFailure("Invalid/unsupported SQLite collection schema.") from exc
        except (KeyError, IndexError, TypeError, ValueError, AttributeError, OverflowError) as exc:
            raise ImportFailure("Invalid/unsupported collection metadata or scheduling payload.") from exc
        digest = hashlib.sha256()
        with source.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        result = {"schemaVersion": 1,
                  "source": {"name": source.name, "sha256": digest.hexdigest(),
                             "importedAt": datetime.fromtimestamp(now, timezone.utc).isoformat()}, **result}
        (temp / "media").mkdir(exist_ok=True)
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        (temp / "collection.json").write_text(encoded + "\n", encoding="utf-8")
        backup = temp / "old-media"
        if (output / "media").exists():
            (output / "media").rename(backup)
        try:
            (temp / "media").rename(output / "media")
            os.replace(temp / "collection.json", output / "collection.json")
        except OSError:
            if backup.exists():
                shutil.rmtree(output / "media", ignore_errors=True)
                backup.rename(output / "media")
            raise
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("--output", type=Path, default=Path(".local/import"))
    parser.add_argument("--timezone", default="Asia/Tokyo", help="IANA timezone for Anki day boundaries (default: Asia/Tokyo)")
    parser.add_argument("--day-start", type=int, choices=range(24), help="Override source rollover when package omits it")
    parser.add_argument("--require-scheduling", action="store_true", help="Fail if all cards are new and no review history exists")
    args = parser.parse_args()
    try:
        result = import_package(args.package, args.output, args.timezone, args.require_scheduling,
                                day_start=args.day_start)
    except (ImportFailure, OSError, ZoneInfoNotFoundError) as exc:
        print(f"Anki import failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"output": str(args.output / "collection.json"),
                      "notes": len(result["notes"]), "cards": len(result["cards"]),
                      "reviews": len(result["reviews"]), "media": len(result["media"]),
                      "warnings": result["warnings"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
