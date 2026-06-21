# Asset Pipeline

Current runtime assets are procedural: ant meshes, food, stones, branches, water, and the ground texture are generated at startup. There are no GLB/KTX2/HDR files in the shipping path yet.

## When Adding Assets

- Use GLB for authored meshes.
- Prefer Meshopt compression for general GLB delivery.
- Use Draco only when static mesh bandwidth dominates and decode cost is acceptable.
- Convert large color textures to KTX2/BasisU.
- Keep normal, roughness, metalness, and AO maps in linear color space.
- Keep mobile texture variants under separate manifest entries instead of replacing desktop assets in place.

## Manifest Direction

Add a small manifest before introducing more than a few files:

```js
export const ASSETS = {
  critical: [],
  lazy: [],
};
```

Critical assets should finish before first interaction. Lazy assets should load after the colony is interactive.
