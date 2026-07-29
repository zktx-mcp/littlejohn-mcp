export type NotificationTone = "success" | "neutral" | "error";

export interface NotificationNotice {
  readonly id: string;
  readonly tone: NotificationTone;
  readonly heading: string;
  readonly message: string;
}

export const notificationClassName = (
  notice: NotificationNotice,
  exiting: boolean,
): string =>
  `notification notification-${notice.tone}${
    exiting ? " notification-exiting" : ""
  }`;

export const notificationRole = (
  notice: NotificationNotice,
): "alert" | "status" =>
  notice.tone === "error" ? "alert" : "status";
