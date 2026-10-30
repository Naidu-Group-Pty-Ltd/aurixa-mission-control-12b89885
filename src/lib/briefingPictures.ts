/**
 * A listing's pictures, made in the operator's browser from the images they
 * pick: a PNG, JPEG or WebP of the right shape becomes the JPEG the website
 * expects, at exactly the size `pictureShape` gives for its slot. The
 * link-preview card can be made from the thumbnail, centred.
 *
 * Nothing here talks to a server. The upload is `uploadPackage` with
 * `planPicturesUpload`, and the server reads each picture's size back from
 * its own bytes before the listing points at it.
 */
import {
  PICTURE_FILE,
  coverCrop,
  pictureShape,
  pictureSizeProblem,
  type Picture,
} from "./websiteBriefings.pure";

export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** A 4K PNG master is 10–25 MB; anything far past that is not a picture someone exported for this. */
export const MAX_PICTURE_BYTES = 60_000_000;
const QUALITY = 0.9;

export type PictureSource = {
  name: string;
  type: string;
  bytes: number;
  width: number;
  height: number;
};

export type PreparedPicture = {
  picture: Picture;
  /** The name it is uploaded as: thumbnail.jpg, poster.jpg or card.jpg. */
  file: string;
  blob: Blob;
  width: number;
  height: number;
  source: PictureSource;
  /** The card, when it was made from the thumbnail rather than picked. */
  fromThumbnail?: boolean;
};

type Drawable = ImageBitmap;

function canvasOf(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot draw pictures.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return { canvas, context };
}

/**
 * The crop of an image drawn at a target size. A large reduction is made in
 * halves, each a high-quality step, so a 4K master becomes a sharp 1200-pixel
 * card rather than an aliased one.
 */
function draw(
  image: Drawable,
  crop: { sx: number; sy: number; sw: number; sh: number },
  width: number,
  height: number,
): HTMLCanvasElement {
  let source: CanvasImageSource = image;
  let { sx, sy, sw, sh } = crop;
  while (sw / 2 >= width && sh / 2 >= height) {
    const half = canvasOf(Math.round(sw / 2), Math.round(sh / 2));
    half.context.drawImage(source, sx, sy, sw, sh, 0, 0, half.canvas.width, half.canvas.height);
    source = half.canvas;
    sx = 0;
    sy = 0;
    sw = half.canvas.width;
    sh = half.canvas.height;
  }
  const out = canvasOf(width, height);
  // A transparent PNG flattens onto black, as the website's dark card does.
  out.context.fillStyle = "#000";
  out.context.fillRect(0, 0, width, height);
  out.context.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
  return out.canvas;
}

function jpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The picture could not be encoded."))),
      "image/jpeg",
      QUALITY,
    ),
  );
}

async function render(
  image: Drawable,
  source: PictureSource,
  picture: Picture,
  orientation: string,
  fromThumbnail = false,
): Promise<PreparedPicture> {
  const shape = pictureShape(picture, orientation);
  const crop = coverCrop(source, shape);
  const blob = await jpeg(draw(image, crop, shape.width, shape.height));
  return {
    picture,
    file: PICTURE_FILE[picture],
    blob,
    width: shape.width,
    height: shape.height,
    source,
    ...(fromThumbnail ? { fromThumbnail } : {}),
  };
}

/**
 * Read a picked image and make the picture from it, or say why it cannot be
 * this picture. The decoded image is returned with it, so the card can be
 * made from a thumbnail without decoding it twice.
 */
export async function preparePicture(input: {
  file: File;
  picture: Picture;
  orientation: string;
}): Promise<
  { ok: true; prepared: PreparedPicture; image: Drawable } | { ok: false; problem: string }
> {
  const { file, picture, orientation } = input;
  if (!(PICTURE_TYPES as readonly string[]).includes(file.type))
    return { ok: false, problem: `${file.name} is not a PNG, JPEG or WebP image.` };
  if (file.size > MAX_PICTURE_BYTES)
    return {
      ok: false,
      problem: `${file.name} is ${Math.round(file.size / 1_000_000)} MB; export it at most ${MAX_PICTURE_BYTES / 1_000_000} MB.`,
    };
  let image: Drawable;
  try {
    image = await createImageBitmap(file);
  } catch {
    return { ok: false, problem: `${file.name} could not be read as an image.` };
  }
  const source: PictureSource = {
    name: file.name,
    type: file.type,
    bytes: file.size,
    width: image.width,
    height: image.height,
  };
  const problem = pictureSizeProblem(picture, orientation, source);
  if (problem) {
    image.close();
    return { ok: false, problem };
  }
  return { ok: true, prepared: await render(image, source, picture, orientation), image };
}

/** The link-preview card made from the thumbnail's own image, centred. */
export function cardFromThumbnail(
  image: Drawable,
  thumbnail: PreparedPicture,
): Promise<PreparedPicture> {
  return render(image, thumbnail.source, "card", "landscape", true);
}
