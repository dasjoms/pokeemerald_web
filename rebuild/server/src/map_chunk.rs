use crate::world::MapData;

const MAP_CHUNK_HEADER_SIZE: usize = 8;
const MAP_CHUNK_TILE_SIZE_WITH_COLLISION: usize = 4;
const MAP_CHUNK_HASH_FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
const MAP_CHUNK_HASH_FNV_PRIME: u64 = 0x00000100000001b3;

pub fn serialize_world_snapshot_map_chunk(map: &MapData) -> Vec<u8> {
    let tile_count = map.tile_count();

    let mut bytes =
        Vec::with_capacity(MAP_CHUNK_HEADER_SIZE + tile_count * MAP_CHUNK_TILE_SIZE_WITH_COLLISION);
    bytes.extend_from_slice(&map.width.to_le_bytes());
    bytes.extend_from_slice(&map.height.to_le_bytes());
    bytes.extend_from_slice(&(tile_count as u32).to_le_bytes());

    for tile_index in 0..tile_count {
        bytes.extend_from_slice(&map.metatile_id[tile_index].to_le_bytes());
        bytes.push(map.collision[tile_index]);
        bytes.push(map.behavior[tile_index]);
    }

    bytes
}

pub fn world_snapshot_map_chunk_hash(map_chunk: &[u8]) -> Vec<u8> {
    let mut hash = MAP_CHUNK_HASH_FNV_OFFSET_BASIS;
    for byte in map_chunk {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(MAP_CHUNK_HASH_FNV_PRIME);
    }

    hash.to_le_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::{serialize_world_snapshot_map_chunk, world_snapshot_map_chunk_hash};
    use crate::world::MapData;

    #[test]
    fn serializes_header_and_row_major_tiles() {
        let map = MapData {
            map_id: "MAP_TEST".to_string(),
            width: 2,
            height: 2,
            metatile_id: vec![11, 12, 13, 14],
            collision: vec![1, 2, 3, 4],
            behavior: vec![21, 22, 23, 24],
            connections: Vec::new(),
        };

        let encoded = serialize_world_snapshot_map_chunk(&map);
        assert_eq!(encoded.len(), 8 + (4 * 4));

        assert_eq!(&encoded[0..2], &2u16.to_le_bytes());
        assert_eq!(&encoded[2..4], &2u16.to_le_bytes());
        assert_eq!(&encoded[4..8], &4u32.to_le_bytes());

        assert_eq!(&encoded[8..12], &[11, 0, 1, 21]);
        assert_eq!(&encoded[12..16], &[12, 0, 2, 22]);
        assert_eq!(&encoded[16..20], &[13, 0, 3, 23]);
        assert_eq!(&encoded[20..24], &[14, 0, 4, 24]);
    }

    #[test]
    fn hash_is_non_empty_and_deterministic() {
        let payload = vec![1, 2, 3, 4, 5, 6, 7];
        let hash_a = world_snapshot_map_chunk_hash(&payload);
        let hash_b = world_snapshot_map_chunk_hash(&payload);

        assert!(!hash_a.is_empty());
        assert_eq!(hash_a, hash_b);
    }
}
