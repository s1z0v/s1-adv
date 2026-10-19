# 0.2.189-dev

Chat composer uses a centered, symmetric vector chevron instead of a font glyph.
Its geometry remains aligned at each composer height.

Thinking uses circular, phase-locked dots on the ring centerline instead of
independent elliptical paths. Pulse arcs are filled, with floating-point angles
and rounded caps calculated from the same endpoints, avoiding detached caps.
The inner animation has four evenly spaced segments.

Host geometry and UI regressions are separate from physical display acceptance.
Existing white clock, REC, KeyRush and push-to-talk changes are preserved.
