/**
 * The small pieces Frame's screens share: a history router, photo URLs, image preparation,
 * relative times, and infinite scroll.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from "react";
import { useFeltKit } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";

// ── Routing: plain history API (the FeltKit server falls back to index.html for app paths). ──
const subscribe = (fn: () => void) => (window.addEventListener("popstate", fn), () => window.removeEventListener("popstate", fn));
export const usePath = () => useSyncExternalStore(subscribe, () => location.pathname);
export function navigate(to: string, replace = false) {
  if (to === location.pathname) return;
  history[replace ? "replaceState" : "pushState"](null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}
export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        rest.onClick?.(e);
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

// ── Photos. A file link is issued per request by posts:media (it checks the image is published),
// lives an hour, and the server sends it `no-store`. Asking once per photo per page load and
// reusing the URL keeps a live feed from re-fetching every image when its data changes
// (see docs/GAP-REGISTER.md, FRAME-GAP-01). ──
const links = new Map<string, Promise<{ url: string; expires: number }>>();
export function usePhotoUrl(fileId: string | undefined): string | undefined {
  const client = useFeltKit();
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!fileId) return setUrl(undefined);
    let live = true;
    let entry = links.get(fileId);
    const fresh = (e: { expires: number }) => e.expires - Date.now() > 120_000;
    const load = () => {
      const p = client.query(api.posts.media, { fileId }).then((l) => ({ url: client.fileUrl(l), expires: Date.parse(l.expiresAt) }));
      links.set(fileId, p);
      p.catch(() => links.delete(fileId));
      return p;
    };
    if (!entry) entry = load();
    entry.then((e) => (fresh(e) ? e : load())).then((e) => live && setUrl(e.url), () => undefined);
    return () => {
      live = false;
    };
  }, [fileId, client]);
  return url;
}

export function Photo({ fileId, alt, className, ratio, onDoubleClick }: { fileId: string; alt: string; className?: string; ratio?: number; onDoubleClick?: () => void }) {
  const url = usePhotoUrl(fileId);
  const [loaded, setLoaded] = useState(false);
  return (
    <div className={`photo ${loaded ? "loaded" : ""} ${className ?? ""}`} style={ratio ? { aspectRatio: String(ratio) } : undefined} onDoubleClick={onDoubleClick}>
      {url && <img src={url} alt={alt} draggable={false} onLoad={() => setLoaded(true)} />}
    </div>
  );
}

export function Avatar({ user, size = 32 }: { user: { username: string; avatarFileId?: string }; size?: number }) {
  const url = usePhotoUrl(user.avatarFileId);
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden>
      {url ? <img src={url} alt="" /> : user.username.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Downscale to at most `max` px on the long side and re-encode as JPEG (strips EXIF, keeps uploads small). */
export async function prepareImage(file: File, max = 1440): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("Could not encode the image."))), "image/jpeg", 0.86));
  return { blob, width, height };
}

const UNITS: Array<[number, string]> = [[60, "s"], [60, "m"], [24, "h"], [7, "d"], [52, "w"]];
export function ago(at: number | string): string {
  let n = Math.max(0, (Date.now() - (typeof at === "string" ? Date.parse(at) : at)) / 1000);
  if (n < 10) return "now";
  for (const [size, unit] of UNITS) {
    if (n < size) return `${Math.floor(n)}${unit}`;
    n /= size;
  }
  return `${Math.floor(n)}y`;
}

/** Calls `onVisible` when the returned element scrolls into view (infinite scroll). */
export function useSentinel(onVisible: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    if (!enabled || !ref.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), { rootMargin: "600px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
