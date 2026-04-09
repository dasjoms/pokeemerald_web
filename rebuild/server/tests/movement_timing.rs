use rebuild_server::{
    movement::{movement_mode_samples_per_tile, WALK_SAMPLE_MS},
    protocol::{Direction, MovementMode},
    session::ActiveWalkTransition,
};

fn transition_for_mode(mode: MovementMode) -> ActiveWalkTransition {
    ActiveWalkTransition::new(
        7,
        "MAP_LITTLEROOT_TOWN".to_string(),
        0,
        0,
        "MAP_LITTLEROOT_TOWN".to_string(),
        1,
        0,
        Direction::Right,
        mode,
    )
}

#[test]
fn movement_modes_complete_on_expected_60hz_sample_counts() {
    for mode in [MovementMode::Walk, MovementMode::Run] {
        let expected_samples = movement_mode_samples_per_tile(mode);
        let mut transition = transition_for_mode(mode);

        for _ in 0..expected_samples.saturating_sub(1) {
            transition.advance(WALK_SAMPLE_MS);
            assert!(
                !transition.is_complete(),
                "transition completed early for mode={mode:?}"
            );
        }

        transition.advance(WALK_SAMPLE_MS);
        assert!(
            transition.is_complete(),
            "transition did not complete for mode={mode:?}"
        );
        assert_eq!(
            transition.progress_pixels(),
            16,
            "tile progress should clamp to one full tile for mode={mode:?}"
        );
    }
}

#[test]
fn movement_timing_is_stable_over_long_sequences() {
    for mode in [MovementMode::Walk, MovementMode::Run] {
        let expected_samples = movement_mode_samples_per_tile(mode);

        for _step in 0..512 {
            let mut transition = transition_for_mode(mode);
            for sample_index in 0..expected_samples {
                transition.advance(WALK_SAMPLE_MS);
                let should_be_complete = sample_index + 1 >= expected_samples;
                assert_eq!(
                    transition.is_complete(),
                    should_be_complete,
                    "completion drift at sample_index={sample_index} mode={mode:?}"
                );
            }
            assert_eq!(transition.progress_pixels(), 16);
        }
    }
}
