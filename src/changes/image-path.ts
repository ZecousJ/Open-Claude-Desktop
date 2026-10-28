/** Whether the Changes panel offers View image for a path (by its extension). */
export const isImagePath = (path: string) =>
  /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i.test(path);
