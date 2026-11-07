"""PyTorch LSTM for daily demand: reads the last two weeks as a sequence, then adds the 7-day average and weekday."""

import numpy as np
import torch
from torch import nn

MAX_EPOCHS = 400
PATIENCE = 40
VALIDATION_SHARE = 0.15


class _Network(nn.Module):
    def __init__(self, extra_features: int, hidden: int):
        super().__init__()
        self.lstm = nn.LSTM(input_size=1, hidden_size=hidden, batch_first=True)
        self.head = nn.Sequential(nn.Linear(hidden + extra_features, 32), nn.ReLU(), nn.Linear(32, 1))

    def forward(self, sequence: torch.Tensor, extra: torch.Tensor) -> torch.Tensor:
        _, (state, _) = self.lstm(sequence)
        return self.head(torch.cat([state[-1], extra], dim=1)).squeeze(1)


class LstmForecaster:
    """Same fit / predict shape as a scikit-learn model. X columns: `lags` values (newest first), then other features."""

    def __init__(self, lags: int, hidden: int = 32, learning_rate: float = 0.005, seed: int = 0):
        self.lags = lags
        self.hidden = hidden
        self.learning_rate = learning_rate
        self.seed = seed
        self.epochs = 0

    def _tensors(self, X: np.ndarray) -> tuple[torch.Tensor, torch.Tensor]:
        scaled = (np.asarray(X, dtype=np.float32) - self.mean) / self.scale
        sequence = torch.from_numpy(scaled[:, : self.lags][:, ::-1].copy()).unsqueeze(-1)  # oldest day first
        return sequence, torch.from_numpy(scaled[:, self.lags :])

    def fit(self, X: np.ndarray, y: np.ndarray) -> "LstmForecaster":
        torch.manual_seed(self.seed)
        X = np.asarray(X, dtype=np.float32)
        self.mean, self.scale = X.mean(axis=0), X.std(axis=0) + 1e-6
        self.y_mean, self.y_scale = float(np.mean(y)), float(np.std(y)) + 1e-6
        target = torch.from_numpy(((np.asarray(y) - self.y_mean) / self.y_scale).astype(np.float32))
        sequence, extra = self._tensors(X)

        split = int(len(X) * (1 - VALIDATION_SHARE))  # time order: validate on the most recent days
        self.network = _Network(extra.shape[1], self.hidden)
        optimiser = torch.optim.Adam(self.network.parameters(), lr=self.learning_rate, weight_decay=1e-4)
        loss_of = nn.MSELoss()
        best_loss, best_state, waited = float("inf"), None, 0
        for self.epochs in range(1, MAX_EPOCHS + 1):
            self.network.train()
            optimiser.zero_grad()
            loss_of(self.network(sequence[:split], extra[:split]), target[:split]).backward()
            optimiser.step()

            self.network.eval()
            with torch.no_grad():
                validation = loss_of(self.network(sequence[split:], extra[split:]), target[split:]).item()
            if validation < best_loss:
                best_loss, waited = validation, 0
                best_state = {k: v.clone() for k, v in self.network.state_dict().items()}
            else:
                waited += 1
                if waited >= PATIENCE:
                    break
        self.network.load_state_dict(best_state)
        self.network.eval()
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        with torch.no_grad():
            scaled = self.network(*self._tensors(np.asarray(X, dtype=np.float32))).numpy()
        return scaled * self.y_scale + self.y_mean

    def describe(self) -> str:
        return f"PyTorch LSTM ({self.hidden} hidden units, Adam), {self.epochs} epochs"
