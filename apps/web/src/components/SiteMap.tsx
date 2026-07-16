'use client';

import { MapContainer, TileLayer, Circle, CircleMarker, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

export interface MapSite {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
}

export interface MapPunch {
  id: string;
  lat: number;
  lng: number;
  flag: 'inside' | 'outside' | 'no_gps';
  label: string;
}

const FLAG_COLOR: Record<string, string> = {
  inside: '#16a34a',
  outside: '#dc2626',
  no_gps: '#d97706',
};

export default function SiteMap({ sites, punches }: { sites: MapSite[]; punches: MapPunch[] }) {
  const center: [number, number] =
    sites.length > 0 ? [sites[0].lat, sites[0].lng] : [40.7128, -74.006];

  return (
    <MapContainer center={center} zoom={13} style={{ height: '70vh', width: '100%' }}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {sites.map((s) => (
        <Circle
          key={s.id}
          center={[s.lat, s.lng]}
          radius={s.radius_m}
          pathOptions={{ color: '#2563eb', fillOpacity: 0.08 }}
        >
          <Popup>
            {s.name} — {s.radius_m}m fence
          </Popup>
        </Circle>
      ))}
      {punches.map((p) => (
        <CircleMarker
          key={p.id}
          center={[p.lat, p.lng]}
          radius={7}
          pathOptions={{ color: FLAG_COLOR[p.flag], fillOpacity: 0.9 }}
        >
          <Popup>{p.label}</Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
