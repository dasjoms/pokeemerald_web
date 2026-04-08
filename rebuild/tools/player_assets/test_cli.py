from __future__ import annotations

import unittest

from rebuild.tools.player_assets import cli


class PlayerAssetsAtlasBoundsTest(unittest.TestCase):
    def test_brendan_may_sheet_rects_are_in_bounds(self) -> None:
        avatars = {avatar["avatar_id"]: avatar for avatar in cli.resolve_assets()}

        for avatar_id in ("brendan", "may"):
            avatar = avatars[avatar_id]
            sheet_dims = {
                source["symbol"]: cli.png_dimensions(cli.resolve_existing_source_path(source["source_path"]))
                for source in avatar["sheet_sources"].values()
            }

            for frame in avatar["frame_atlas"].values():
                sheet_width, sheet_height = sheet_dims[frame["sheet_symbol"]]
                rect = frame["rect"]
                self.assertLessEqual(rect["x"] + rect["w"], sheet_width)
                self.assertLessEqual(rect["y"] + rect["h"], sheet_height)

    def test_brendan_may_walking_running_use_single_row_layout(self) -> None:
        avatars = {avatar["avatar_id"]: avatar for avatar in cli.resolve_assets()}

        for avatar_id in ("brendan", "may"):
            avatar = avatars[avatar_id]
            expected_symbols = {
                avatar["sheet_sources"]["normal"]["symbol"],
                avatar["sheet_sources"]["running"]["symbol"],
            }

            for frame in avatar["frame_atlas"].values():
                if frame["sheet_symbol"] not in expected_symbols:
                    continue

                rect = frame["rect"]
                self.assertEqual(rect["y"], 0)
                self.assertEqual(rect["x"], frame["sheet_frame_index"] * rect["w"])


if __name__ == "__main__":
    unittest.main()
