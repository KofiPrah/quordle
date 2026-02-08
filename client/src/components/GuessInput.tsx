interface GuessInputProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    disabled: boolean;
}

export function GuessInput({ value, onChange, onSubmit, disabled }: GuessInputProps) {
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && value.length === 5) {
            onSubmit();
        }
    };

    return (
        <div className="flex gap-2">
            <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value.toLowerCase().slice(0, 5))}
                onKeyDown={handleKeyDown}
                disabled={disabled}
                placeholder="Enter guess"
                maxLength={5}
                className="px-4 py-2 border-2 border-gray-300 rounded text-lg uppercase tracking-widest w-40 text-center"
            />
            <button
                onClick={onSubmit}
                disabled={disabled || value.length !== 5}
                className="px-4 py-2 bg-blue-500 text-white rounded font-bold disabled:opacity-50 disabled:cursor-not-allowed"
            >
                Submit
            </button>
        </div>
    );
}
