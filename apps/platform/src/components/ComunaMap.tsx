'use client';

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo } from 'react';
import { GeoJSON, MapContainer, TileLayer, useMap } from 'react-leaflet';
import type { ComunaMap as ComunaMapData, ComunaMapFeature } from '@guardia/shared';
import { SERVICE_COLOR, SERVICE_STATUS } from '@/lib/labels';

function FitBounds({ data }: { data: ComunaMapData }) {
  const map = useMap();
  useEffect(() => {
    if (!data.features.length) return;
    const bounds = L.geoJSON(data as unknown as GeoJSON.FeatureCollection).getBounds();
    // Isla de Pascua y Juan Fernández estiran Valparaíso hasta el Pacífico: el encuadre usa el continente.
    const mainland = data.features.filter((f) => !isFarIsland(f));
    const fit = mainland.length ? L.geoJSON({ type: 'FeatureCollection', features: mainland } as unknown as GeoJSON.FeatureCollection).getBounds() : bounds;
    if (fit.isValid()) map.fitBounds(fit, { padding: [12, 12] });
  }, [data, map]);
  return null;
}

/** Comunas insulares lejanas (CUT 5201 Isla de Pascua, 5104 Juan Fernández). */
function isFarIsland(f: ComunaMapFeature): boolean {
  return f.properties.cut === 5201 || f.properties.cut === 5104;
}

/**
 * Mapa de comunas coloreadas por el estado de su municipio (RF-1.2). Cada clic devuelve el CUT; el
 * contenido (nombre de la comuna) se muestra como texto en el tooltip, nunca como HTML.
 */
export default function ComunaMap({
  data,
  onSelect,
  selectedCut,
  height = 520,
}: {
  data: ComunaMapData;
  onSelect?: (cut: number) => void;
  selectedCut?: number | null;
  height?: number;
}) {
  // GeoJSON de react-leaflet no reacciona a cambios de datos: la key lo vuelve a montar.
  const key = useMemo(
    () => `${data.features.length}:${data.features.map((f) => f.properties.status[0]).join('')}:${selectedCut ?? ''}`,
    [data, selectedCut],
  );

  return (
    <div style={{ height }} className="rounded-lg overflow-hidden border border-line">
      <MapContainer center={[-35.5, -71.5]} zoom={4} style={{ height: '100%', width: '100%' }} scrollWheelZoom preferCanvas>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <GeoJSON
          key={key}
          data={data as unknown as GeoJSON.FeatureCollection}
          style={(f) => {
            const p = (f as unknown as ComunaMapFeature).properties;
            const selected = p.cut === selectedCut;
            return {
              color: selected ? '#e9f1fb' : '#0c1d36',
              weight: selected ? 2.5 : 0.6,
              fillColor: SERVICE_COLOR[p.status],
              fillOpacity: p.status === 'AVAILABLE' ? 0.18 : 0.6,
            };
          }}
          onEachFeature={(f, layer) => {
            const p = (f as unknown as ComunaMapFeature).properties;
            const tip = document.createElement('div');
            const name = document.createElement('strong');
            name.textContent = p.name;
            const status = document.createElement('div');
            status.textContent = SERVICE_STATUS[p.status];
            tip.append(name, status);
            layer.bindTooltip(tip, { sticky: true, className: 'gi-tip' });
            if (onSelect) layer.on('click', () => onSelect(p.cut));
          }}
        />
        <FitBounds data={data} />
      </MapContainer>
    </div>
  );
}
