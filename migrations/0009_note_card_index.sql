-- Support note card details and own-deck EXISTS without repeated full card scans.
CREATE INDEX cards_note_deck ON cards(note_id,deck_id);
