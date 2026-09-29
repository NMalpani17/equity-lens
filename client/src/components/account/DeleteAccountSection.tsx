import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteAccount } from "@/lib/api";
import { setAuthFlash } from "@/lib/authFlash";
import { useAuth } from "@/context/auth-context";

/** Word the user must type to confirm irreversible account deletion. */
const CONFIRM_WORD = "DELETE";

/** Danger zone: permanently delete the account behind a typed confirmation. */
export function DeleteAccountSection() {
  const { signOut } = useAuth();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = confirmText.trim() === CONFIRM_WORD;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setConfirmText("");
      setError(null);
    }
  }

  async function handleDelete() {
    if (!confirmed) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteAccount();
      // Hand a confirmation to the login page, then clear the dead session.
      setAuthFlash("Your account has been deleted.");
      await signOut();
      navigate("/login", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete your account.");
      setDeleting(false);
    }
  }

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="text-destructive">Danger zone</CardTitle>
        <CardDescription>
          Permanently delete your account and all of your holdings. This cannot be
          undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog open={open} onOpenChange={onOpenChange}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">Delete account</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete your account?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently deletes your account and every holding. To confirm,
                type <span className="font-semibold">{CONFIRM_WORD}</span> below.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm-delete" className="sr-only">
                Type {CONFIRM_WORD} to confirm
              </Label>
              <Input
                id="confirm-delete"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={CONFIRM_WORD}
                autoComplete="off"
                disabled={deleting}
              />
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
              <Button
                variant="destructive"
                onClick={() => void handleDelete()}
                disabled={!confirmed || deleting}
              >
                {deleting && <Loader2 className="animate-spin" />}
                Delete account
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
