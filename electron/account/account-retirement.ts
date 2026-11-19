/** Read-side lifecycle fence; it never performs account or permission changes. */
export class AccountRetirement {
  private generation = 0;
  private retiring = true;
  get accountActivationIdentity() {
    return this.generation;
  }
  get accountRetiring() {
    return this.retiring;
  }
  beginActivation() {
    this.retiring = true;
    return ++this.generation;
  }
  beginDeactivation() {
    this.retiring = true;
    ++this.generation;
  }
  finishActivation(generation: number) {
    if (generation !== this.generation) return;
    this.retiring = false;
  }
}
