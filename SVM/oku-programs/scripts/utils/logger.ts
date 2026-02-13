/**
 * Colored console logging utility
 */

import chalk from 'chalk';

export class Logger {
  private step: number = 0;
  private totalSteps: number = 0;

  constructor(totalSteps: number = 0) {
    this.totalSteps = totalSteps;
  }

  setTotalSteps(total: number) {
    this.totalSteps = total;
  }

  nextStep(message: string) {
    this.step++;
    const prefix =
      this.totalSteps > 0 ? `[${this.step}/${this.totalSteps}]` : `[${this.step}]`;
    console.log(chalk.bold.blue(`\n${prefix} ${message}...`));
  }

  success(message: string, indent: boolean = true) {
    const prefix = indent ? '  ✓ ' : '✓ ';
    console.log(chalk.green(`${prefix}${message}`));
  }

  error(message: string, indent: boolean = true) {
    const prefix = indent ? '  ✗ ' : '✗ ';
    console.error(chalk.red(`${prefix}${message}`));
  }

  warning(message: string, indent: boolean = true) {
    const prefix = indent ? '  ⚠️  ' : '⚠️  ';
    console.warn(chalk.yellow(`${prefix}${message}`));
  }

  info(message: string, indent: boolean = true) {
    const prefix = indent ? '  ℹ ' : 'ℹ ';
    console.log(chalk.cyan(`${prefix}${message}`));
  }

  log(message: string) {
    console.log(message);
  }

  header(message: string) {
    console.log(chalk.bold.magenta(`\n${'='.repeat(60)}`));
    console.log(chalk.bold.magenta(`  ${message}`));
    console.log(chalk.bold.magenta(`${'='.repeat(60)}\n`));
  }

  section(message: string) {
    console.log(chalk.bold.cyan(`\n${message}`));
    console.log(chalk.cyan(`${'-'.repeat(40)}`));
  }

  keypair(label: string, pubkey: string) {
    console.log(`  ${chalk.gray(label + ':')} ${chalk.white(pubkey)}`);
  }

  json(data: any) {
    console.log(JSON.stringify(data, null, 2));
  }

  table(data: Record<string, string>) {
    const maxKeyLength = Math.max(...Object.keys(data).map((k) => k.length));
    for (const [key, value] of Object.entries(data)) {
      console.log(
        `  ${chalk.gray(key.padEnd(maxKeyLength))}: ${chalk.white(value)}`
      );
    }
  }
}

export const logger = new Logger();
