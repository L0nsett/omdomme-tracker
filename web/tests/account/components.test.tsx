import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeaveProfile } from "@/components/account/leave-profile";
import { ProfileForm } from "@/components/account/profile-form";
import { EMPTY_FORM } from "@/lib/auth/profile-form";

afterEach(cleanup);

describe("LeaveProfile", () => {
  it("asks for confirmation in the page before leaving", () => {
    const action = vi.fn(async () => ({}));
    render(<LeaveProfile action={action} isLastMember={false} isOwner={true} />);
    expect(screen.queryByText(/Are you sure/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Leave profile" }));
    expect(screen.getByText(/Are you sure/)).toBeTruthy();
    expect(screen.getByText(/Ownership passes/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Are you sure/)).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });

  it("warns that the profile is deleted when the last member leaves", () => {
    render(<LeaveProfile action={async () => ({})} isLastMember={true} isOwner={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Leave profile" }));
    expect(screen.getByText(/deleted permanently/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yes, leave and delete profile" })).toBeTruthy();
  });
});

describe("ProfileForm", () => {
  it("serialises the edited state into the hidden profile field", () => {
    const { container } = render(
      <ProfileForm action={async () => ({})} initial={EMPTY_FORM} submitLabel="Create profile" pendingLabel="…" />,
    );
    fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "ReLU NTNU" } });
    fireEvent.change(screen.getByLabelText("Ambiguous term 1"), { target: { value: "ReLU" } });
    fireEvent.change(screen.getByLabelText("Context words for ambiguous term 1"), { target: { value: "NTNU" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add ambiguous term" }));
    expect(screen.getByLabelText("Ambiguous term 2")).toBeTruthy();
    const hidden = container.querySelector('input[name="profile"]') as HTMLInputElement;
    const state = JSON.parse(hidden.value);
    expect(state.name).toBe("ReLU NTNU");
    expect(state.ambiguous).toEqual([
      { term: "ReLU", context: "NTNU" },
      { term: "", context: "" },
    ]);
  });
});
