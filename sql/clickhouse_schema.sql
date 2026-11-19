-- sql/clickhouse_schema.sql
CREATE TABLE IF NOT EXISTS economy_item_events (
    event_date Date DEFAULT toDate(ts),
    ts DateTime64(3, 'UTC'),
    tx_id UInt64,
    action LowCardinality(String),
    src_owner_type UInt8,
    src_owner_id UInt64,
    dst_owner_type UInt8,
    dst_owner_id UInt64,
    item_def_id UInt32,
    delta_amount Int32,
    server_shard LowCardinality(String)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (item_def_id, src_owner_id, ts, tx_id)
TTL event_date + INTERVAL 180 DAY
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS economy_hourly_flow_mv
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, item_def_id, action)
AS SELECT
    toStartOfHour(ts) AS hour,
    item_def_id,
    action,
    sum(abs(delta_amount)) AS total_volume,
    count() AS tx_count
FROM economy_item_events
GROUP BY hour, item_def_id, action;
