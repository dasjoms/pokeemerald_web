from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from rebuild.tools.field_effect_assets import cli


class FieldEffectAssetsTest(unittest.TestCase):
    def test_resolve_assets_has_shadow_and_jump_landing_effects(self) -> None:
        payload = cli.resolve_assets()
        self.assertEqual(payload["version"], cli.FIELD_EFFECT_ASSETS_VERSION)
        self.assertIn("shadow", payload["effects"])
        self.assertIn("ground_impact_dust", payload["effects"])
        self.assertIn("jump_tall_grass", payload["effects"])
        self.assertIn("jump_long_grass", payload["effects"])
        self.assertIn("jump_small_splash", payload["effects"])
        self.assertIn("jump_big_splash", payload["effects"])
        self.assertIn("bike_tire_tracks", payload["effects"])

    def test_shadow_templates_and_offsets_align(self) -> None:
        payload = cli.resolve_assets()
        shadow = payload["effects"]["shadow"]
        self.assertEqual(len(shadow["templates"]), 4)
        self.assertEqual(len(shadow["shadow_template_ids"]), 4)
        self.assertEqual(len(shadow["shadow_vertical_offsets"]), 4)

    def test_jump_landing_animation_durations_match_reference(self) -> None:
        payload = cli.resolve_assets()
        expected = {
            "ground_impact_dust": [8, 8, 8],
            "jump_tall_grass": [8, 8, 8, 8],
            "jump_long_grass": [4, 4, 8, 8, 8, 8],
            "jump_small_splash": [4, 4, 4],
            "jump_big_splash": [8, 8, 8, 8],
        }
        for effect_key, durations in expected.items():
            effect = payload["effects"][effect_key]["template"]
            symbol = effect["anim_table"]["anim_cmd_symbols"][0]
            frames = effect["anim_table"]["sequences"][symbol]
            self.assertEqual([frame["duration"] for frame in frames], durations)

    def test_runtime_asset_write_emits_png_and_palette_outputs(self) -> None:
        payload = cli.resolve_assets()
        with tempfile.TemporaryDirectory() as td:
            out = Path(td)
            index_path = cli.write_runtime_assets(out, payload)
            index = json.loads(index_path.read_text(encoding="utf-8"))
            output_paths = [Path(entry["output_path"]) for entry in index["files"]]
            self.assertTrue(any(path.suffix.lower() == ".png" for path in output_paths))
            self.assertTrue(any(path.suffix.lower() in {".gbapal", ".pal"} for path in output_paths))
            pic_names = {path.name for path in output_paths if "pics" in path.parts}
            self.assertIn("ground_impact_dust.png", pic_names)
            self.assertIn("jump_tall_grass.png", pic_names)
            self.assertIn("jump_long_grass.png", pic_names)
            self.assertIn("jump_small_splash.png", pic_names)
            self.assertIn("jump_big_splash.png", pic_names)
            self.assertIn("bike_tire_tracks.png", pic_names)
            palette_names = {path.name for path in output_paths if "palettes" in path.parts}
            self.assertIn("general_0.pal", palette_names)

    def test_bike_tire_tracks_transition_and_timing_metadata_matches_reference(self) -> None:
        payload = cli.resolve_assets()
        bike = payload["effects"]["bike_tire_tracks"]
        self.assertEqual(bike["field_effect_id"], "FLDEFF_BIKE_TIRE_TRACKS")
        self.assertEqual(bike["helper_function"], "FldEff_BikeTireTracks")
        self.assertEqual(bike["helper_update_callback"], "UpdateFootprintsTireTracksFieldEffect")
        self.assertEqual(bike["template"]["pic_table_symbol"], "sPicTable_BikeTireTracks")
        self.assertEqual(bike["template"]["anim_table_symbol"], "sAnimTable_BikeTireTracks")

        anim_symbols = bike["template"]["anim_table"]["anim_cmd_symbols"]
        self.assertEqual(
            anim_symbols,
            [
                "sBikeTireTracksAnim_South",
                "sBikeTireTracksAnim_South",
                "sBikeTireTracksAnim_North",
                "sBikeTireTracksAnim_West",
                "sBikeTireTracksAnim_East",
                "sBikeTireTracksAnim_SECornerTurn",
                "sBikeTireTracksAnim_SWCornerTurn",
                "sBikeTireTracksAnim_NWCornerTurn",
                "sBikeTireTracksAnim_NECornerTurn",
            ],
        )
        sequences = bike["template"]["anim_table"]["sequences"]
        self.assertTrue(sequences["sBikeTireTracksAnim_SWCornerTurn"][0]["h_flip"])
        self.assertTrue(sequences["sBikeTireTracksAnim_NWCornerTurn"][0]["h_flip"])
        self.assertFalse(sequences["sBikeTireTracksAnim_SECornerTurn"][0]["h_flip"])
        self.assertFalse(sequences["sBikeTireTracksAnim_NECornerTurn"][0]["h_flip"])

        transitions = bike["transition_mapping"]
        self.assertEqual(transitions["direction_index_order"], ["down", "up", "left", "right"])
        self.assertEqual(
            transitions["table"],
            [
                [1, 2, 7, 8],
                [1, 2, 6, 5],
                [5, 8, 3, 4],
                [6, 7, 3, 4],
            ],
        )
        self.assertEqual(transitions["by_previous_direction"]["up"]["right"], 5)
        self.assertEqual(transitions["by_previous_direction"]["left"]["up"], 8)

        timing = bike["fade_timing"]
        self.assertEqual(timing["step0_wait_until_timer_gt"], 40)
        self.assertEqual(timing["step1_stop_when_timer_gt"], 56)
        self.assertEqual(timing["step1_blink"]["mode"], "toggle_visibility_each_frame")

    def test_extract_command_supports_external_output_dir(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            out = Path(td)
            exit_code = cli.command_extract(out, clean=False)
            self.assertEqual(exit_code, 0)
            manifest = out / "field_effects" / "acro_bike_effects_manifest.json"
            runtime_index = out / "field_effects" / "acro_bike" / "runtime_asset_index.json"
            self.assertTrue(manifest.exists())
            self.assertTrue(runtime_index.exists())


if __name__ == "__main__":
    unittest.main()
