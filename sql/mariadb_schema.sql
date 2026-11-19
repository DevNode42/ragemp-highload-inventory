-- sql/mariadb_schema.sql
CREATE TABLE IF NOT EXISTS inventory_slots (
    owner_type TINYINT UNSIGNED NOT NULL,
    owner_id BIGINT UNSIGNED NOT NULL,
    slot_idx SMALLINT UNSIGNED NOT NULL,
    item_def_id INT UNSIGNED NOT NULL,
    amount INT UNSIGNED NOT NULL,
    durability SMALLINT UNSIGNED NOT NULL DEFAULT 1000,
    meta_hash BINARY(16) NOT NULL DEFAULT 0x00000000000000000000000000000000,
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (owner_id, owner_type, slot_idx),
    KEY idx_item_lookup (item_def_id, owner_type, owner_id)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_bin
  PARTITION BY HASH(owner_id)
  PARTITIONS 32;
