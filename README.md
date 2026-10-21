# Lanai Diorama

An interactive 3D "cake slice" diorama of an arched steel-and-glass loggia with an outdoor kitchen, floating on its own little island in the sky. Built with [three.js](https://threejs.org/) r128 as a single HTML page, with every texture generated in code.

## Features

- Arched steel-and-glass French doors and casements, hip roofs, a two-story tower and a herringbone-tile wing
- A round slice of land torn out of the earth: lawn, shrubs and a paved terrace with a pool, with soil and rock layers exposed on the torn edge
- A floating rock island with dangling roots and vines, plus small islets drifting below
- A 24-hour sky with gradient sunrises and sunsets, a moon, thousands of twinkling stars and a Milky Way, all rotating around the island
- A sun dial: drag it around the clock and the sky swings past and rubber-bands back into place
- Click the dial's center to dissolve the roof into glowing embers (and click again to bring it back)
- Reflective Fresnel glass, a mirrored pool surface, caustics on the pool floor, contact shadows and glowing lights at night
- Works on phones: one finger to orbit, pinch to zoom, two fingers to pan, double-tap to reset the view

## Run it

Open `index.html` in a modern browser. It loads three.js from cdnjs and OrbitControls from jsDelivr, so it needs an internet connection.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The complete page, with all code inlined |
| `src/sky.js` | Sky dome, sun and moon, stars, clouds and the floating island (also inlined in `index.html`) |
| `src/textures.js` | Procedural textures: stucco, tile, pavers, shingles, soil section, pool mosaic and more (also inlined in `index.html`) |
