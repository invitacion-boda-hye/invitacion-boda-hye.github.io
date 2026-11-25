import heic2any from 'heic2any';

// Produce un JPEG pequeño en el dispositivo; no envía archivos a terceros.
export async function preparePhoto(file) {
  let source = file;
  if (/\.(heic|heif)$/i.test(file.name) || /image\/hei[cf]/i.test(file.type)) {
    source = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
    if (Array.isArray(source)) source = source[0];
  }
  const url = URL.createObjectURL(source);
  try {
    const image = new Image(); image.src = url; await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 80000000) throw new Error('INVALID_IMAGE');
    const scale = Math.min(1, 2000 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('CANVAS_UNAVAILABLE');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.75, 0.65, 0.5]) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.type === 'image/jpeg' && blob.size <= 2097152) return blob;
    }
    throw new Error('IMAGE_TOO_LARGE');
  } finally { URL.revokeObjectURL(url); }
}
