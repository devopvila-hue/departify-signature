/**
 * Mounts a pre-rendered pdf.js canvas into the React tree.
 *
 * pdf.js owns the canvas element (it draws into it directly), so React only
 * provides the host container. `replaceChildren` keeps the mount idempotent
 * under React's StrictMode double-invocation.
 */
import { useEffect, useRef } from 'react';

export function CanvasHost({ canvas }: { canvas: HTMLCanvasElement }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren(canvas);
    return () => {
      if (canvas.parentNode === host) host.replaceChildren();
    };
  }, [canvas]);

  return <div ref={hostRef} style={{ lineHeight: 0 }} />;
}
