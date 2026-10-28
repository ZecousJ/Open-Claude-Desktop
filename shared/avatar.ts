import type { SettingsPreferences } from "./settings-extras";

export const avatarCount = 72;
export const avatarUploadTypes = ["image/png", "image/jpeg", "image/webp"];
export const avatarUploadLimit = 50 * 1024 * 1024;
/** The saved, cropped photo (512 px JPEG), not the picked file. */
export const avatarPhotoLimit = 512 * 1024;

export function randomAvatar(random = Math.random): number {
  return Math.floor(random() * avatarCount) + 1;
}

export function avatarSource(
  settings: Pick<SettingsPreferences, "avatar" | "avatarPhoto">,
  base = "/",
): string | undefined {
  if (settings.avatarPhoto) return settings.avatarPhoto;
  const variant = settings.avatar ?? 0;
  return Number.isInteger(variant) && variant >= 1 && variant <= avatarCount
    ? `${base}avatars/${variant}.svg`
    : undefined;
}

export interface AvatarCrop {
  x: number;
  y: number;
  size: number;
}

// Crop bounds and zoom limits.
export function initialAvatarCrop(width: number, height: number): AvatarCrop {
  const size = Math.min(width, height);
  return { x: (width - size) / 2, y: (height - size) / 2, size };
}

export function avatarMaxZoom(width: number, height: number): number {
  return Math.max(1, Math.min(4, Math.min(width, height) / 256));
}

export function boundAvatarCrop(
  crop: AvatarCrop,
  width: number,
  height: number,
): AvatarCrop {
  const minimum = Math.min(width, height);
  const size = Math.max(
    minimum / avatarMaxZoom(width, height),
    Math.min(minimum, crop.size),
  );
  return {
    x: Math.max(0, Math.min(width - size, crop.x)),
    y: Math.max(0, Math.min(height - size, crop.y)),
    size,
  };
}

export function zoomAvatarCrop(
  crop: AvatarCrop,
  width: number,
  height: number,
  zoom: number,
  anchor = { x: 0.5, y: 0.5 },
): AvatarCrop {
  const size =
    Math.min(width, height) /
    Math.max(1, Math.min(avatarMaxZoom(width, height), zoom));
  return boundAvatarCrop(
    {
      x: crop.x + (crop.size - size) * anchor.x,
      y: crop.y + (crop.size - size) * anchor.y,
      size,
    },
    width,
    height,
  );
}
