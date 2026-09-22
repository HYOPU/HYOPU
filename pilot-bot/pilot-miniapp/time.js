/** Accept explicit 24-hour HHmm; never guess missing digits or repair invalid time. */
export function formatPilotTime(value) {
 const match = value.match(/^([01]\d|2[0-3])([0-5]\d)$/);
 return match ? `${match[1]}:${match[2]}` : value;
}
