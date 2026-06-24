# Terrain texture drop-in assets

The current terrain renderer uses a procedural CanvasTexture fallback, so the app does not require binary texture files to boot.

Drop future authored textures here using these stable names:

- `park_ground_atlas.png`
- `grass_patch.png`
- `leaf_litter.png`
- `gravel_patch.png`
- `root_bark.png`
- `mud_patch.png`
- `pavement_crack.png`

Guidelines:

- Top-down, ant-scale park ground surfaces.
- No text, watermark, people, or animals.
- Color/albedo textures should be authored in sRGB.
- Normal, roughness, metalness, height, and mask maps should stay linear.
- Prefer KTX2/BasisU for large production textures after the art direction is locked.
