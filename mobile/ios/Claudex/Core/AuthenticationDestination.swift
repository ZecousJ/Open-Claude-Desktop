/// Authentication gates the whole app; a cold restore never exposes empty chat.
public enum AuthenticationDestination: Equatable, Sendable {
    case restoring, login, chat
    public static func resolve(restoring: Bool, signedIn: Bool) -> Self {
        if restoring { return .restoring }
        return signedIn ? .chat : .login
    }
}
