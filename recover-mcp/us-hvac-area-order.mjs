import { prioritizeAreas } from './national-yield-priority.mjs';

// Keep nationwide acquisition focused on the highest-yield population tiers first.
// Trigger the production controller onto the robust yield-priority runner.
export function orderControllerAreas(rows=[]) {
  return prioritizeAreas(rows).map(area => ({
    ...area,
    partition_state: area.partition_state || area.state,
    partition_city: area.partition_city || area.city,
    partition_zip: area.partition_zip || area.zip,
  }));
}
