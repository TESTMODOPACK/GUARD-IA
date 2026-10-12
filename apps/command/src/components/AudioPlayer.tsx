'use client';

import { useEffect, useState } from 'react';
import type { MediaPublic } from '@guardia/shared';
import { api } from '@/lib/api';

/**
 * Reproductor del audio del SOS. La URL firmada dura 5 min: si el navegador
 * falla al cargarla, se pide una firma nueva una sola vez.
 */
export function AudioPlayer({ media }: { media: MediaPublic }) {
  const [url, setUrl] = useState(media.url);
  const [refreshed, setRefreshed] = useState(false);
  const [gone, setGone] = useState(!media.url);

  useEffect(() => {
    setUrl(media.url);
    setRefreshed(false);
    setGone(!media.url);
  }, [media.id, media.url]);

  const onError = async () => {
    if (refreshed) {
      setGone(true);
      return;
    }
    setRefreshed(true);
    try {
      const fresh = await api.mediaUrl(media.id);
      setUrl(fresh.url);
    } catch {
      setGone(true);
    }
  };

  if (gone) {
    return <p className="text-sm text-ink-muted">El audio ya no está disponible (purgado por retención).</p>;
  }
  return (
    <div className="flex items-center gap-3">
      <audio key={url ?? 'none'} controls preload="metadata" src={url ?? undefined} onError={onError} className="w-full h-9" />
      {media.durationS ? <span className="text-xs text-ink-muted tabular-nums shrink-0">{Math.round(media.durationS)} s</span> : null}
    </div>
  );
}
