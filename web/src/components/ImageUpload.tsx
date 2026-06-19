import { useRef, useState } from 'react';
import { Upload, X, ImageIcon } from 'lucide-react';
import { Button, inputClass } from './ui';

/**
 * Pick an image, downscale it client-side, and emit a small inline data URL
 * (stored directly on the branding/member doc — no Cloud Storage needed). Also
 * accepts a pasted image URL. Keeps Firestore docs small by capping dimensions.
 */
async function fileToDataUrl(
  file: File,
  maxDim: number,
  format: 'png' | 'jpeg',
): Promise<string> {
  const sourceUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('decode failed'));
    i.src = sourceUrl;
  });
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return sourceUrl;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL(format === 'png' ? 'image/png' : 'image/jpeg', 0.85);
}

export function ImageUpload({
  label,
  value,
  onChange,
  hint,
  shape = 'round',
  maxDim = 320,
  format = 'jpeg',
}: {
  label: string;
  value: string;
  onChange: (dataUrlOrUrl: string) => void;
  hint?: string;
  shape?: 'round' | 'rect';
  maxDim?: number;
  format?: 'png' | 'jpeg';
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    if (!file.type.startsWith('image/')) {
      setErr('Please choose an image file.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setErr('That image is too large (max 10MB).');
      return;
    }
    setBusy(true);
    try {
      onChange(await fileToDataUrl(file, maxDim, format));
    } catch {
      setErr('Could not process that image.');
    } finally {
      setBusy(false);
    }
  };

  const preview =
    shape === 'round'
      ? 'h-16 w-16 rounded-full object-cover'
      : 'h-16 w-28 rounded-lg object-contain bg-white/5';

  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">
        {label}
      </span>
      <div className="flex items-center gap-3">
        {value ? (
          <img src={value} alt="" className={`${preview} ring-1 ring-hair-soft`} />
        ) : (
          <div
            className={`flex items-center justify-center text-faint ring-1 ring-hair-soft ${preview}`}
          >
            <ImageIcon size={20} />
          </div>
        )}
        <div className="flex flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => pick(e.target.files?.[0])}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              <Upload size={15} /> {busy ? 'Processing…' : value ? 'Replace' : 'Upload'}
            </Button>
            {value && (
              <Button type="button" variant="ghost" onClick={() => onChange('')}>
                <X size={15} /> Remove
              </Button>
            )}
          </div>
        </div>
      </div>
      <input
        className={`${inputClass} mt-2`}
        value={value.startsWith('data:') ? '' : value}
        placeholder="…or paste an image URL"
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="mt-1 block text-xs text-faint">{hint}</span>}
      {err && <span className="mt-1 block text-xs text-red-300">{err}</span>}
    </div>
  );
}
