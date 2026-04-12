use crate::map_runtime::MAP_OFFSET;

pub const WHEEL_SUBTILE_SIZE: i32 = 32;
pub const METATILE_STEP_SUBTILES: i32 = 2;
const REDRAW_SLICE_STRIDE: i32 = 2;
const REDRAW_SLICE_SPAN: i32 = 32;
const REDRAW_OPPOSITE_EDGE_OFFSET: i32 = 28;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CameraWheelState {
    pub camera_pos_x: i32,
    pub camera_pos_y: i32,
    pub x_tile_offset: i32,
    pub y_tile_offset: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StripRedrawSample {
    pub dest_x: i32,
    pub dest_y: i32,
    pub world_x: i32,
    pub world_y: i32,
}

impl CameraWheelState {
    pub fn from_camera_runtime(camera_runtime_x: i32, camera_runtime_y: i32) -> Self {
        let camera_pos_x = camera_runtime_x - MAP_OFFSET as i32;
        let camera_pos_y = camera_runtime_y - MAP_OFFSET as i32;
        Self {
            camera_pos_x,
            camera_pos_y,
            x_tile_offset: wrap32(camera_pos_x * METATILE_STEP_SUBTILES),
            y_tile_offset: wrap32(camera_pos_y * METATILE_STEP_SUBTILES),
        }
    }

    pub fn apply_metatile_step(&mut self, delta_x: i32, delta_y: i32) -> Vec<StripRedrawSample> {
        if delta_x == 0 && delta_y == 0 {
            return Vec::new();
        }

        // Emerald order: update camera map position first.
        self.camera_pos_x += delta_x;
        self.camera_pos_y += delta_y;

        // Then AddCameraTileOffset(delta*2) in subtile units.
        self.x_tile_offset = wrap32(self.x_tile_offset + delta_x * METATILE_STEP_SUBTILES);
        self.y_tile_offset = wrap32(self.y_tile_offset + delta_y * METATILE_STEP_SUBTILES);

        // Then redraw strips using updated offsets.
        let mut strips = Vec::new();
        if delta_x != 0 {
            strips.extend(self.redraw_vertical_strip(delta_x));
        }
        if delta_y != 0 {
            strips.extend(self.redraw_horizontal_strip(delta_y));
        }
        strips
    }

    fn redraw_horizontal_strip(&self, delta_y: i32) -> Vec<StripRedrawSample> {
        let mut strip = Vec::with_capacity((REDRAW_SLICE_SPAN / REDRAW_SLICE_STRIDE) as usize);
        let dest_y = if delta_y > 0 {
            wrap32(self.y_tile_offset + REDRAW_OPPOSITE_EDGE_OFFSET)
        } else {
            self.y_tile_offset
        };
        let world_y = if delta_y > 0 {
            self.camera_pos_y + 14
        } else {
            self.camera_pos_y
        };

        for i in (0..REDRAW_SLICE_SPAN).step_by(REDRAW_SLICE_STRIDE as usize) {
            strip.push(StripRedrawSample {
                dest_x: wrap32(self.x_tile_offset + i),
                dest_y,
                world_x: self.camera_pos_x + i / METATILE_STEP_SUBTILES,
                world_y,
            });
        }

        strip
    }

    fn redraw_vertical_strip(&self, delta_x: i32) -> Vec<StripRedrawSample> {
        let mut strip = Vec::with_capacity((REDRAW_SLICE_SPAN / REDRAW_SLICE_STRIDE) as usize);
        let dest_x = if delta_x > 0 {
            wrap32(self.x_tile_offset + REDRAW_OPPOSITE_EDGE_OFFSET)
        } else {
            self.x_tile_offset
        };
        let world_x = if delta_x > 0 {
            self.camera_pos_x + 14
        } else {
            self.camera_pos_x
        };

        for i in (0..REDRAW_SLICE_SPAN).step_by(REDRAW_SLICE_STRIDE as usize) {
            strip.push(StripRedrawSample {
                dest_x,
                dest_y: wrap32(self.y_tile_offset + i),
                world_x,
                world_y: self.camera_pos_y + i / METATILE_STEP_SUBTILES,
            });
        }

        strip
    }
}

fn wrap32(value: i32) -> i32 {
    value.rem_euclid(WHEEL_SUBTILE_SIZE)
}

#[cfg(test)]
mod tests {
    use super::{CameraWheelState, StripRedrawSample};

    #[test]
    fn one_step_north_uses_updated_offsets_and_plus_28_destination_row() {
        let mut state = CameraWheelState {
            camera_pos_x: 100,
            camera_pos_y: 200,
            x_tile_offset: 6,
            y_tile_offset: 10,
        };

        let strip = state.apply_metatile_step(0, 1);

        assert_eq!(state.x_tile_offset, 6);
        assert_eq!(state.y_tile_offset, 12);
        assert_eq!(strip.len(), 16);
        assert_eq!(strip[0], sample(6, 8, 100, 215));
        assert_eq!(strip[15], sample(4, 8, 115, 215));
    }

    #[test]
    fn one_step_south_redraws_at_current_y_offset() {
        let mut state = CameraWheelState {
            camera_pos_x: 2,
            camera_pos_y: 3,
            x_tile_offset: 30,
            y_tile_offset: 2,
        };

        let strip = state.apply_metatile_step(0, -1);

        assert_eq!(state.y_tile_offset, 0);
        assert_eq!(strip[0], sample(30, 0, 2, 2));
        assert_eq!(strip[1], sample(0, 0, 3, 2));
    }

    #[test]
    fn one_step_east_wrap_case_uses_current_x_offset() {
        let mut state = CameraWheelState {
            camera_pos_x: 40,
            camera_pos_y: 20,
            x_tile_offset: 1,
            y_tile_offset: 31,
        };

        let strip = state.apply_metatile_step(-1, 0);

        assert_eq!(state.x_tile_offset, 31);
        assert_eq!(strip[0], sample(31, 31, 39, 20));
        assert_eq!(strip[1], sample(31, 1, 39, 21));
    }

    #[test]
    fn one_step_west_wrap_case_uses_plus_28_destination_column() {
        let mut state = CameraWheelState {
            camera_pos_x: 40,
            camera_pos_y: 20,
            x_tile_offset: 30,
            y_tile_offset: 0,
        };

        let strip = state.apply_metatile_step(1, 0);

        assert_eq!(state.x_tile_offset, 0);
        assert_eq!(strip[0], sample(28, 0, 55, 20));
        assert_eq!(strip[15], sample(28, 30, 55, 35));
    }

    #[test]
    fn diagonal_step_emits_independent_axis_strips() {
        let mut state = CameraWheelState {
            camera_pos_x: 12,
            camera_pos_y: 8,
            x_tile_offset: 28,
            y_tile_offset: 30,
        };

        let strips = state.apply_metatile_step(1, -1);

        assert_eq!(state.x_tile_offset, 30);
        assert_eq!(state.y_tile_offset, 28);
        assert_eq!(strips.len(), 32);
        assert_eq!(strips[0], sample(26, 28, 27, 7));
        assert_eq!(strips[16], sample(30, 28, 13, 7));
    }

    fn sample(dest_x: i32, dest_y: i32, world_x: i32, world_y: i32) -> StripRedrawSample {
        StripRedrawSample {
            dest_x,
            dest_y,
            world_x,
            world_y,
        }
    }
}
