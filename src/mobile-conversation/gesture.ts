/** An admission gate only: never renew it from a host result or async continuation. */
export class ConversationGesture {
  private until = -Infinity;
  constructor(private readonly now = () => performance.now()) {}
  observe(isTrusted: boolean) {
    if (isTrusted) this.until = this.now() + 1500;
  }
  active() {
    return this.now() <= this.until;
  }
  reset() {
    this.until = -Infinity;
  }
}
