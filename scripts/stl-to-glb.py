#!/usr/bin/env python3
"""Convert STL to GLB (glTF binary) with category-based material colors."""

import sys
import trimesh
import numpy as np

# Part category colors (matching PART_COLORS in constants.ts)
CATEGORY_COLORS = {
    "supports": [0.969, 0.714, 0.0, 1.0],    # #f7b600 (HR_YELLOW)
    "connectors": [0.0, 0.337, 0.702, 1.0],   # #0056b3 (HR_BLUE)
    "lockpins": [0.769, 0.118, 0.227, 1.0],   # #c41e3a (HR_RED)
}

def convert(stl_path: str, glb_path: str, category: str = "supports"):
    mesh = trimesh.load(stl_path)

    # Apply material color based on category
    color = CATEGORY_COLORS.get(category, [0.5, 0.5, 0.5, 1.0])
    color_rgba = (np.array(color) * 255).astype(np.uint8)

    if isinstance(mesh, trimesh.Scene):
        for geometry in mesh.geometry.values():
            geometry.visual = trimesh.visual.ColorVisuals(
                mesh=geometry,
                face_colors=np.tile(color_rgba, (len(geometry.faces), 1))
            )
    else:
        mesh.visual = trimesh.visual.ColorVisuals(
            mesh=mesh,
            face_colors=np.tile(color_rgba, (len(mesh.faces), 1))
        )

    # Export as GLB
    mesh.export(glb_path, file_type="glb")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <input.stl> <output.glb> [category]")
        sys.exit(1)

    stl_path = sys.argv[1]
    glb_path = sys.argv[2]
    category = sys.argv[3] if len(sys.argv) > 3 else "supports"

    convert(stl_path, glb_path, category)
