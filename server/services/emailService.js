export async function sendWelcomeEmail(email, username) {
  console.log(`Welcome email sent to ${email}`);
}

export async function sendPasswordResetEmail(email, token) {
  console.log(`Password reset link for ${email}: ${token}`);
}