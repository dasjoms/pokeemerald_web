from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from rebuild.tools.field_effect_assets import cli


class FieldEffectAssetsTest(unittest.TestCase):
    def test_resolve_assets_has_shadow_and_dust(self) -> None:
        payload = cli.resolve_assets()
        self.assertEqual(payload["version"], cli.FIELD_EFFECT_ASSETS_VERSION)
        self.assertIn("shadow", payload["effects"])
        self.assertIn("ground_impact_dust", payload["effects"])

    def test_shadow_templates_and_offsets_align(self) -> None:
        payload = cli.resolve_assets()
        shadow = payload["effects"]["shadow"]
        self.assertEqual(len(shadow["templates"]), 4)
        self.assertEqual(len(shadow["shadow_template_ids"]), 4)
        self.assertEqual(len(shadow["shadow_vertical_offsets"]), 4)

    def test_dust_animation_is_three_frames_of_eight(self) -> None:
        payload = cli.resolve_assets()
        dust = payload["effects"]["ground_impact_dust"]["template"]
        symbol = dust["anim_table"]["anim_cmd_symbols"][0]
        frames = dust["anim_table"]["sequences"][symbol]
        self.assertEqual([frame["duration"] for frame in frames], [8, 8, 8])

    def test_runtime_asset_write_emits_png_and_palette_outputs(self) -> None:
        payload = cli.resolve_assets()
        with tempfile.TemporaryDirectory() as td:
            out = Path(td)
            index_path = cli.write_runtime_assets(out, payload)
            index = json.loads(index_path.read_text(encoding="utf-8"))
            output_paths = [Path(entry["output_path"]) for entry in index["files"]]
            self.assertTrue(any(path.suffix.lower() == ".png" for path in output_paths))
            self.assertTrue(any(path.suffix.lower() in {".gbapal", ".pal"} for path in output_paths))


if __name__ == "__main__":
    unittest.main()
