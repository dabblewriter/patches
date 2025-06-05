export let log = console.log;

export function verbose(value: boolean) {
  log = value ? console.log : () => undefined;
}
