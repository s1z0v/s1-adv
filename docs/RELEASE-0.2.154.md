# 0.2.154-dev

NES renders across the full screen height. Classic 4:3 uses 180×135 pixels;
F switches to a 240×135 fill mode and back without restarting the game.
The capture buffer retains all 256 horizontal source pixels. The bank cache
is capped at ten 8 KiB pages to keep the memory budget bounded.

RGB565 scanlines now use the graphics driver's explicitly typed native RGB
format. This corrects the byte-order mismatch that distorted game colors.
The game fills its viewport without a permanent footer over the image.

Enter sends a bounded Start press on its rising edge. Escape is the game-exit
key. An SD read error pauses the current game and shows an error until Escape;
it cannot silently send the user back to the list. Sector-sized reads retry
one empty read and handle partial reads without losing the offset.

Games remain on SD, including the independently licensed demo. No commercial
ROMs are included in firmware, source, or releases. The English defaults and
silent inbox polling from 0.2.153 are retained.
