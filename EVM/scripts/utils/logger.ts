/**
 * Simple colored console logger for deployment scripts
 */

export const logger = {
  success: (msg: string) => console.log(`\x1b[32m✓\x1b[0m ${msg}`),
  error: (msg: string) => console.log(`\x1b[31m✗\x1b[0m ${msg}`),
  info: (msg: string) => console.log(`\x1b[36mℹ\x1b[0m ${msg}`),
  warning: (msg: string) => console.log(`\x1b[33m⚠\x1b[0m ${msg}`),
  section: (msg: string) => console.log(`\n\x1b[1m=== ${msg} ===\x1b[0m`),
  step: (num: number, msg: string) => console.log(`\x1b[1m${num}.\x1b[0m ${msg}`),
};
