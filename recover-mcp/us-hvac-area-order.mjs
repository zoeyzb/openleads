import { prioritizeAreas } from './national-yield-priority.mjs';

export function orderControllerAreas(rows=[]) {
  return prioritizeAreas(rows).map(area => ({
    ...area,
    partition_state: area.partition_state || area.state,
    partition_city: area.partition_city || area.city,
    partition_zip: area.partition_zip || area.zip,
  }));
}
