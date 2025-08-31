const status = document.getElementById("status");

document.getElementById("backup").addEventListener("click", () => {
  status.textContent = "Backing up...";
  chrome.runtime.sendMessage({ action: "backup" }, (response) => {
    status.textContent = response?.success
      ? "Backup complete!"
      : response.error;
  });
});

document.getElementById("restore").addEventListener("click", () => {
  status.textContent = "Restoring...";
  chrome.runtime.sendMessage({ action: "restore" }, (response) => {
    status.textContent = response?.success
      ? "Restore complete!"
      : response.error;
  });
});
