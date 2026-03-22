function formatApacheTimestamp(date = new Date()): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    date.getMonth()
  ];
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absMinutes / 60)).padStart(2, '0');
  const offsetRemainder = String(absMinutes % 60).padStart(2, '0');

  return `${day}/${month}/${year}:${hours}:${minutes}:${seconds} ${sign}${offsetHours}${offsetRemainder}`;
}

function quote(value: string | null | undefined): string {
  return value && value.length > 0 ? value.replaceAll('"', '\\"') : '-';
}

export function logHttpRequest(config: {
  ip: string;
  method: string;
  path: string;
  status: number;
  bytes?: number | string;
  referer?: string | null;
  userAgent?: string | null;
}) {
  const bytes = config.bytes ?? '-';
  console.log(
    `${config.ip} - - [${formatApacheTimestamp()}] "${config.method} ${config.path} HTTP/1.1" ${config.status} ${bytes} "${quote(config.referer)}" "${quote(config.userAgent)}"`,
  );
}

export function logBlueskyEvent(config: {
  event: 'CONNECT' | 'DISCONNECT';
  filterText: string;
  endpoint: string;
  detail?: string;
}) {
  const suffix = config.detail ? ` detail="${config.detail.replaceAll('"', '\\"')}"` : '';
  console.log(
    `server - - [${formatApacheTimestamp()}] "BLUESKY_${config.event} filter=\\"${config.filterText || '__all__'}\\" endpoint=\\"${config.endpoint}\\"${suffix}" 200 - "-" "-"`,
  );
}
