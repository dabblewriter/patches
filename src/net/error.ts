export class StatusError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
  }
}
