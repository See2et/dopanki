CREATE INDEX imported_reviews_time ON imported_reviews(json_extract(data, '$.reviewedAt'));
