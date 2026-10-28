/** CLAUDEX: a user picked on the devices or usage rules page. */
export interface PickedUser {
  id: number
  /** Empty when the user was picked by ID only. */
  email: string
  username?: string
}
