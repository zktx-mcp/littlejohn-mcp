export type NotificationTone = "success" | "neutral" | "error";

export interface NotificationNotice {
  readonly id: string;
  readonly tone: NotificationTone;
  readonly heading: string;
  readonly message: string;
}
