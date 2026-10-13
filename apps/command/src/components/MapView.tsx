'use client';

import { useEffect, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapContainer, Marker, TileLayer, Tooltip, useMap } from 'react-leaflet';
import type { AnyAlert } from '@/lib/store';
import { ACTIVE_STATUSES, representatives, useStore } from '@/lib/store';
import { categoryLabel, UNIT_STATUS } from '@/lib/labels';

/** Centro por defecto: Santiago. Se recentra en la primera alerta o unidad con posición. */
const DEFAULT_CENTER: [number, number] = [-33.5, -70.65];

/**
 * Íconos cacheados por apariencia: misma instancia entre renders, así react-leaflet no reemplaza el
 * DOM del marcador en cada cambio del store (y el pulso de "nueva" no se reinicia).
 */
const icons = new Map<string, L.DivIcon>();
function cachedIcon(key: string, make: () => L.DivIcon): L.DivIcon {
  let icon = icons.get(key);
  if (!icon) {
    icon = make();
    icons.set(key, icon);
  }
  return icon;
}

function alertIcon(a: AnyAlert, selected: boolean, pulse: boolean) {
  const priority = a.priority ?? 'NONE';
  return cachedIcon(`a|${priority}|${selected}|${pulse}`, () =>
    L.divIcon({
      className: '',
      html: `<div class="gi-marker" data-priority="${priority}" data-selected="${selected}" data-pulse="${pulse}"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    }),
  );
}

function unitIcon(status: string) {
  return cachedIcon(`u|${status}`, () =>
    L.divIcon({
      className: '',
      html: `<div class="gi-unit" data-status="${status}"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    }),
  );
}

/** Vuela a la alerta seleccionada; solo cuando cambia la selección o su posición. */
function FlyToSelected({ id, lat, lng }: { id: string | null; lat?: number; lng?: number }) {
  const map = useMap();
  useEffect(() => {
    if (!id || lat === undefined || lng === undefined) return;
    map.flyTo([lat, lng], Math.max(map.getZoom(), 15), { duration: 0.6 });
  }, [id, lat, lng, map]);
  return null;
}

/** Al cargar, encuadra lo que haya (alertas activas y unidades). */
function FitOnce({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    const b = L.latLngBounds(points);
    map.fitBounds(b.pad(0.25), { maxZoom: 14 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points.length > 0]);
  return null;
}

export default function MapView() {
  const alerts = useStore((s) => s.alerts);
  const units = useStore((s) => s.units);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const fresh = useStore((s) => s.fresh);

  // Un marcador por situación: los reportes repetidos del mismo bache no tapan el mapa.
  const active = useMemo(() => representatives(Object.values(alerts).filter((a) => ACTIVE_STATUSES.includes(a.status))), [alerts]);
  const selected = selectedId ? (alerts[selectedId] ?? null) : null;
  const unitList = useMemo(() => Object.values(units).filter((u) => u.lastLocation), [units]);

  const points = useMemo<[number, number][]>(
    () => [
      ...active.map((a) => [a.location.lat, a.location.lng] as [number, number]),
      ...unitList.map((u) => [u.lastLocation!.lat, u.lastLocation!.lng] as [number, number]),
    ],
    [active, unitList],
  );

  return (
    <MapContainer center={DEFAULT_CENTER} zoom={12} className="h-full w-full" zoomControl preferCanvas>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitOnce points={points} />
      <FlyToSelected id={selected?.id ?? null} lat={selected?.location.lat} lng={selected?.location.lng} />

      {unitList.map((u) => (
        <Marker key={u.id} position={[u.lastLocation!.lat, u.lastLocation!.lng]} icon={unitIcon(u.status)}>
          <Tooltip direction="top" offset={[0, -8]}>
            {u.code} · {UNIT_STATUS[u.status]}
          </Tooltip>
        </Marker>
      ))}

      {active.map((a) => (
        <Marker
          key={a.id}
          position={[a.location.lat, a.location.lng]}
          icon={alertIcon(a, a.id === selectedId, a.id in fresh && a.status === 'PENDING')}
          zIndexOffset={a.id === selectedId ? 1000 : a.priority === 'HIGH' ? 500 : 0}
          eventHandlers={{ click: () => select(a.id) }}
        >
          <Tooltip direction="top" offset={[0, -10]}>
            {categoryLabel(a.category, a.type === 'EMERGENCY_SOS' ? 'SOS' : 'Reporte')}
          </Tooltip>
        </Marker>
      ))}
    </MapContainer>
  );
}
