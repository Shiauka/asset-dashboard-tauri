// en-CA locale produces YYYY-MM-DD format, combined with Asia/Taipei timezone
export function getTaiwanToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' })
}
