export function formatAudioMilliseconds(milliseconds: number) {
  const safeMilliseconds = Number.isFinite(milliseconds) ? Math.max(0, Math.round(milliseconds)) : 0;
  const hours = Math.floor(safeMilliseconds / 3_600_000);
  const minutes = Math.floor((safeMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMilliseconds % 60_000) / 1000);
  const remainder = safeMilliseconds % 1000;
  const clock = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${remainder.toString().padStart(3, "0")}`;
  return hours > 0 ? `${hours}:${clock}` : clock;
}

export function formatAudioTime(seconds: number) {
  return formatAudioMilliseconds(seconds * 1000);
}
