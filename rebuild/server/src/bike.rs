use crate::{
    movement::{StepSpeed, MB_MUDDY_SLOPE},
    protocol::{Direction, MovementMode, RejectionReason},
};

const ACRO_WHEELIE_PREP_WINDOW_TICKS: u64 = 12;
const ACRO_HOP_TICKS: u8 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraversalMode {
    OnFoot,
    MachBike,
    AcroBike,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BikeState {
    Mach { speed_tier: u8, last_dir: Direction },
    AcroNeutral,
    AcroWheeliePrep { dir: Direction, start_tick: u64 },
    AcroWheelieMove { dir: Direction },
    AcroHop { dir: Direction, remaining_ticks: u8 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TraversalState {
    pub mode: TraversalMode,
    pub bike_state: Option<BikeState>,
}

impl Default for TraversalState {
    fn default() -> Self {
        Self {
            mode: TraversalMode::OnFoot,
            bike_state: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BikeDecision {
    pub next_state: TraversalState,
    pub step_speed: StepSpeed,
}

pub fn decide_bike_traversal(
    traversal: TraversalState,
    requested_mode: MovementMode,
    direction: Direction,
    source_behavior: u8,
    destination_behavior: u8,
    server_tick: u64,
) -> Result<BikeDecision, RejectionReason> {
    let _ = source_behavior;
    if destination_behavior == MB_MUDDY_SLOPE && requested_mode != MovementMode::MachBike {
        return Err(RejectionReason::BikeTileRequiresMach);
    }

    match requested_mode {
        MovementMode::Walk | MovementMode::Run => Ok(BikeDecision {
            next_state: TraversalState::default(),
            step_speed: if requested_mode == MovementMode::Run {
                StepSpeed::Step2
            } else {
                StepSpeed::Step1
            },
        }),
        MovementMode::MachBike => {
            let (speed_tier, last_dir) = match traversal.bike_state {
                Some(BikeState::Mach {
                    speed_tier,
                    last_dir,
                }) if traversal.mode == TraversalMode::MachBike => {
                    if last_dir != direction && speed_tier >= 2 {
                        return Err(RejectionReason::BikeTurnTooSharp);
                    }
                    let next_tier = if last_dir == direction {
                        speed_tier.saturating_add(1).min(3)
                    } else {
                        1
                    };
                    (next_tier, direction)
                }
                _ => (1, direction),
            };

            let speed = match speed_tier {
                1 => StepSpeed::Step3,
                2 => StepSpeed::Step4,
                _ => StepSpeed::Step8,
            };

            Ok(BikeDecision {
                next_state: TraversalState {
                    mode: TraversalMode::MachBike,
                    bike_state: Some(BikeState::Mach {
                        speed_tier,
                        last_dir,
                    }),
                },
                step_speed: speed,
            })
        }
        MovementMode::AcroCruise => Ok(BikeDecision {
            next_state: TraversalState {
                mode: TraversalMode::AcroBike,
                bike_state: Some(BikeState::AcroNeutral),
            },
            step_speed: StepSpeed::Step2,
        }),
        MovementMode::AcroWheeliePrep => Ok(BikeDecision {
            next_state: TraversalState {
                mode: TraversalMode::AcroBike,
                bike_state: Some(BikeState::AcroWheeliePrep {
                    dir: direction,
                    start_tick: server_tick,
                }),
            },
            step_speed: StepSpeed::Step1,
        }),
        MovementMode::AcroWheelieMove => {
            let Some(BikeState::AcroWheeliePrep { dir, start_tick }) = traversal.bike_state else {
                return Err(RejectionReason::BikeInvalidStateTransition);
            };

            if traversal.mode != TraversalMode::AcroBike || dir != direction {
                return Err(RejectionReason::BikeInvalidStateTransition);
            }

            if server_tick.saturating_sub(start_tick) > ACRO_WHEELIE_PREP_WINDOW_TICKS {
                return Err(RejectionReason::BikeWheelieWindowExpired);
            }

            Ok(BikeDecision {
                next_state: TraversalState {
                    mode: TraversalMode::AcroBike,
                    bike_state: Some(BikeState::AcroWheelieMove { dir: direction }),
                },
                step_speed: StepSpeed::Step2,
            })
        }
        MovementMode::BunnyHop => {
            let (Some(BikeState::AcroWheeliePrep { dir, .. })
            | Some(BikeState::AcroWheelieMove { dir })) = traversal.bike_state
            else {
                return Err(RejectionReason::BikeInvalidStateTransition);
            };

            if traversal.mode != TraversalMode::AcroBike || dir != direction {
                return Err(RejectionReason::BikeInvalidStateTransition);
            }

            Ok(BikeDecision {
                next_state: TraversalState {
                    mode: TraversalMode::AcroBike,
                    bike_state: Some(BikeState::AcroHop {
                        dir: direction,
                        remaining_ticks: ACRO_HOP_TICKS,
                    }),
                },
                step_speed: StepSpeed::Step1,
            })
        }
    }
}

pub fn advance_bike_state_for_tick(state: TraversalState) -> TraversalState {
    let Some(BikeState::AcroHop {
        dir,
        remaining_ticks,
    }) = state.bike_state
    else {
        return state;
    };

    if remaining_ticks <= 1 {
        return TraversalState {
            mode: TraversalMode::AcroBike,
            bike_state: Some(BikeState::AcroNeutral),
        };
    }

    TraversalState {
        mode: TraversalMode::AcroBike,
        bike_state: Some(BikeState::AcroHop {
            dir,
            remaining_ticks: remaining_ticks - 1,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mach_bike_accelerates_and_rejects_sharp_turns_at_speed() {
        let mut state = TraversalState::default();
        let first =
            decide_bike_traversal(state, MovementMode::MachBike, Direction::Right, 0, 0, 10)
                .expect("first mach move accepted");
        assert_eq!(first.step_speed, StepSpeed::Step3);
        state = first.next_state;

        let second =
            decide_bike_traversal(state, MovementMode::MachBike, Direction::Right, 0, 0, 11)
                .expect("second mach move accepted");
        assert_eq!(second.step_speed, StepSpeed::Step4);
        state = second.next_state;

        let rejected =
            decide_bike_traversal(state, MovementMode::MachBike, Direction::Up, 0, 0, 12);
        assert_eq!(rejected, Err(RejectionReason::BikeTurnTooSharp));
    }

    #[test]
    fn acro_wheelie_move_requires_prep_within_window() {
        let prep = decide_bike_traversal(
            TraversalState::default(),
            MovementMode::AcroWheeliePrep,
            Direction::Up,
            0,
            0,
            100,
        )
        .expect("prep accepted");
        let ok = decide_bike_traversal(
            prep.next_state,
            MovementMode::AcroWheelieMove,
            Direction::Up,
            0,
            0,
            104,
        );
        assert!(ok.is_ok());

        let expired = decide_bike_traversal(
            prep.next_state,
            MovementMode::AcroWheelieMove,
            Direction::Up,
            0,
            0,
            200,
        );
        assert_eq!(expired, Err(RejectionReason::BikeWheelieWindowExpired));
    }
}
