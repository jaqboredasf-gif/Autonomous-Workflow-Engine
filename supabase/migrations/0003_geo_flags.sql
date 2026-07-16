-- Server-side geofence validation. Clients send raw lat/lng; the flag is
-- computed here so it can't be spoofed by a modified app. Flag, never block.

create or replace function haversine_m(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns double precision
language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(
    pow(sin(radians((lat2 - lat1) / 2)), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) *
    pow(sin(radians((lng2 - lng1) / 2)), 2)
  ));
$$;

create or replace function set_geo_flags() returns trigger
language plpgsql as $$
declare
  s job_sites%rowtype;
begin
  if new.job_site_id is not null then
    select * into s from job_sites where id = new.job_site_id;
  end if;

  if s.id is null or new.in_lat is null or new.in_lng is null then
    new.in_geo_flag := 'no_gps';
  elsif haversine_m(new.in_lat, new.in_lng, s.lat, s.lng) <= s.radius_m then
    new.in_geo_flag := 'inside';
  else
    new.in_geo_flag := 'outside';
  end if;

  if new.clock_out is not null then
    if s.id is null or new.out_lat is null or new.out_lng is null then
      new.out_geo_flag := 'no_gps';
    elsif haversine_m(new.out_lat, new.out_lng, s.lat, s.lng) <= s.radius_m then
      new.out_geo_flag := 'inside';
    else
      new.out_geo_flag := 'outside';
    end if;
  end if;

  return new;
end $$;

create trigger time_entries_geo
  before insert or update on time_entries
  for each row execute function set_geo_flags();
