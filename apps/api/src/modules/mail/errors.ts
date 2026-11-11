export class MailError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MailError";
  }
}
