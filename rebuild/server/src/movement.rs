use crate::protocol::Facing;

#[derive(Debug, Clone, Copy)]
pub enum MoveValidation {
    Accepted { next_x: u16, next_y: u16 },
    Collision,
    OutOfBounds,
}

pub fn validate_walk(
    x: u16,
    y: u16,
    facing: Facing,
    width: u16,
    height: u16,
    collision: &[u8],
) -> MoveValidation {
    let (dx, dy) = match facing {
        Facing::Up => (0_i32, -1_i32),
        Facing::Down => (0, 1),
        Facing::Left => (-1, 0),
        Facing::Right => (1, 0),
    };

    let next_x = x as i32 + dx;
    let next_y = y as i32 + dy;

    if next_x < 0 || next_y < 0 || next_x >= width as i32 || next_y >= height as i32 {
        return MoveValidation::OutOfBounds;
    }

    let next_x = next_x as u16;
    let next_y = next_y as u16;
    let index = next_y as usize * width as usize + next_x as usize;
    if collision.get(index).copied().unwrap_or(1) != 0 {
        return MoveValidation::Collision;
    }

    MoveValidation::Accepted { next_x, next_y }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_collision_tiles() {
        let collision = vec![0, 1, 0, 0];
        let result = validate_walk(0, 0, Facing::Right, 2, 2, &collision);
        assert!(matches!(result, MoveValidation::Collision));
    }
}
