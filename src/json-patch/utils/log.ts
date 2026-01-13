export let log: (...args: any[]) => void = () => undefined;

export function verbose(value: boolean) {
  log = value ? console.log : () => undefined;
}
